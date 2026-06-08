import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { addChatMessage, ensureSessionBelongsToUser, getOrCreateUser } from "@/lib/chat/store";
import { MAX_MESSAGE_LENGTH } from "@/lib/chat/constants";
import { sanitizeChatHistory } from "@/lib/chat/history";
import {
  extractReferencedTitle,
  isNotionLinkRequest,
} from "@/lib/chat/link-lookup";
import { expandSearchQueries } from "@/lib/chat/multi-query";
import { reformulateSearchQuery } from "@/lib/chat/query-reformulation";
import { streamGeminiAnswer } from "@/lib/chat/stream-response";
import { resolveQuery } from "@/lib/query/resolve-query";
import type { ParsedQuery } from "@/lib/query/types";
import { handleMetadataQuery, lookupPageLinkByTitle } from "@/lib/sql/answers";
import {
  isSqlMissAnswer,
  isTeamActivityMetadataGap,
  shouldFallbackToRag,
} from "@/lib/chat/answer-quality";
import {
  isMetadataOnlyKind,
  metadataNotFoundAnswer,
} from "@/lib/chat/routing-policy";
import { logChatRoute, logRetrievalDiagnostics } from "@/lib/chat/retrieval-diagnostics";
import { buildNotionContextWithConfidence } from "@/lib/rag/build-context";
import { RETRIEVAL_REFUSAL_MESSAGE } from "@/lib/rag/retrieval-confidence";
import { normalizeLanguage } from "@/lib/chat/normalize-language";


function stripTitleEmoji(title: string) {
  return title
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Use the user's project name for RAG, not a misleading canonical page title. */
function resolveRagTitleBoost(parsed: ParsedQuery, message: string) {
  if (parsed.kind === "team_activity") {
    const match = message.match(
      /(?:most|mostly)\s+active\s+(?:team\s+member|person|contributor|member)?\s*(?:in|on|for)\s+([^?.!]+?)(?:\?|$)/i,
    );
    const scope = match?.[1]
      ?.replace(/\b(team|workspace|project|projects)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (scope) return stripTitleEmoji(scope);
  }
  return parsed.docTitle ? stripTitleEmoji(parsed.docTitle) : "";
}

function isExplicitPageQuestion(message: string, docTitle?: string) {
  if (!docTitle?.trim()) return false;
  const needle = stripTitleEmoji(docTitle).toLowerCase();
  if (needle.length < 4) return false;
  return message.toLowerCase().includes(needle.slice(0, Math.min(needle.length, 24)));
}

const SCOPED_RAG_KINDS = new Set<ParsedQuery["kind"]>([
  "owner_list",
  "created_by_list",
  "assigned_list",
  "worked_on_list",
  "activity_summary",
]);

export type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
  sessionId?: unknown;
};

type PipelineContext = {
  message: string;
  history: ChatHistoryItem[];
  sessionId: string | null;
};

/**
 * Main chat flow — read these steps top to bottom.
 *
 * 1. Link shortcut (no AI)
 * 2. Classify question (router)
 * 3. SQL answer when possible
 * 4. History-aware query reformulation → RAG retrieval → LLM stream
 */
/**
 * Replace first-person pronouns with the logged-in user's first name so that
 * "tasks assigned to me" correctly searches for the real Notion owner name.
 * Only replaces standalone "me", "my", "I" (word boundaries) to avoid false hits
 * inside other words.
 */
function resolveFirstPerson(message: string, session: Session): string {
  const fullName = session?.user?.name?.trim();
  if (!fullName) return message;
  // Use first name only (e.g. "Tamanna" from "Tamanna Singh")
  const firstName = fullName.split(/\s+/)[0];
  return message.replace(/\b(me|my|myself|I)\b/g, firstName);
}

export async function runChatPipeline(session: Session, body: ChatRequestBody) {
  const rawMessage = validateMessage(body.message);
  
  // Save raw message to DB, then build the processed version for the pipeline
  const sessionId = await attachSession(session, body.sessionId, rawMessage);
  
  const normalized = await normalizeLanguage(rawMessage);
  const message = resolveFirstPerson(normalized, session);
  
  const history = sanitizeChatHistory(body.history);
  const ctx: PipelineContext = { message, history, sessionId };

  const linkResponse = await tryNotionLinkAnswer(ctx);
  if (linkResponse) return linkResponse;

  const parsed = await resolveQuery(message);
  logParsedQuery(parsed);

  const sqlResponse = await trySqlAnswer(parsed, ctx);
  if (sqlResponse) return sqlResponse;

  if (isNotionLinkRequest(message)) {
    return jsonAnswer(sessionId, "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.");
  }

  return tryRagAnswer(parsed, ctx, session);
}

function validateMessage(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ChatValidationError("Message is required");
  }
  return raw.trim().slice(0, MAX_MESSAGE_LENGTH);
}

export class ChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

async function attachSession(
  session: Session,
  rawSessionId: unknown,
  message: string,
): Promise<string | null> {
  if (typeof rawSessionId !== "string" || !rawSessionId.trim()) return null;

  const user = await getOrCreateUser(session);
  const ownsSession = await ensureSessionBelongsToUser(rawSessionId, user.id);
  if (!ownsSession) throw new ChatNotFoundError();

  await addChatMessage(rawSessionId, "user", message);
  return rawSessionId;
}

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

async function jsonAnswer(sessionId: string | null, answer: string) {
  if (sessionId) await addChatMessage(sessionId, "bot", answer);
  return NextResponse.json({ answer });
}

async function tryNotionLinkAnswer(ctx: PipelineContext) {
  if (!isNotionLinkRequest(ctx.message)) return null;

  const linkTitle = extractReferencedTitle(ctx.message, ctx.history);
  if (linkTitle) {
    const linkAnswer = await lookupPageLinkByTitle(linkTitle);
    if (linkAnswer) return jsonAnswer(ctx.sessionId, linkAnswer);
    return jsonAnswer(
      ctx.sessionId,
      `I couldn't find a synced Notion page titled **${linkTitle}**. Use **Sync changes**, or ask with the exact page title from Notion.`,
    );
  }

  if (/\b(it|this|that)\b/i.test(ctx.message)) {
    const unresolved =
      ctx.history.length > 0
        ? "I couldn't resolve which page you mean from chat history. Ask again with the full page title, e.g. link for **Structuring the Product Team**."
        : "I couldn't resolve which page you mean — include the page title, or ask about a page first so chat history has context.";
    return jsonAnswer(ctx.sessionId, unresolved);
  }

  return null;
}

function logParsedQuery(parsed: ParsedQuery) {
  if (process.env.NODE_ENV === "production") return;
  console.log("[chat] parsed_query=", {
    kind: parsed.kind,
    confidence: parsed.confidence,
    source: parsed.source,
    personName: parsed.personName,
    docTitle: parsed.docTitle,
  });
}

async function trySqlAnswer(parsed: ParsedQuery, ctx: PipelineContext) {
  if (parsed.kind === "semantic") return null;

  const metadataOnly = isMetadataOnlyKind(parsed.kind);
  const directAnswer = await handleMetadataQuery(parsed);

  // DEBUG LOG — remove after bug is found
  console.log("[trySqlAnswer] debug", {
    kind: parsed.kind,
    metadataOnly,
    directAnswerLength: directAnswer?.length ?? null,
    directAnswerPreview: directAnswer?.slice(0, 80) ?? null,
    isMiss: directAnswer ? isSqlMissAnswer(directAnswer) : "no answer",
  });

  if (metadataOnly) {
    if (directAnswer?.trim() && !isSqlMissAnswer(directAnswer)) {
      logChatRoute("sql_hit", parsed, { answer_chars: directAnswer.length });
      return jsonAnswer(ctx.sessionId, directAnswer);
    }
    if (parsed.kind === "team_activity" && isTeamActivityMetadataGap(directAnswer)) {
      logChatRoute("sql_weak_rag", parsed, { team_activity_metadata_gap: true });
      return null;
    }
    logChatRoute("sql_miss_metadata", parsed, { had_sql: Boolean(directAnswer) });
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(parsed));
  }

  if (directAnswer && !shouldFallbackToRag(parsed, directAnswer)) {
    logChatRoute("sql_hit", parsed, { answer_chars: directAnswer.length });
    return jsonAnswer(ctx.sessionId, directAnswer);
  }

  if (directAnswer) {
    logChatRoute("sql_weak_rag", parsed, { answer_chars: directAnswer.length });
  } else {
    logChatRoute("sql_weak_rag", parsed, { sql_empty: true });
  }

  return null;
}



async function tryRagAnswer(parsed: ParsedQuery, ctx: PipelineContext, session: Session) {
  if (isMetadataOnlyKind(parsed.kind) && parsed.kind !== "team_activity") {
    logChatRoute("sql_miss_metadata", parsed, { blocked_rag: true });
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(parsed));
  }

  const titleBoost = resolveRagTitleBoost(parsed, ctx.message);
  const explicitPage = isExplicitPageQuestion(ctx.message, parsed.docTitle);

  let searchQuery: string;
  let method = "original";

  if (explicitPage && titleBoost) {
    searchQuery = titleBoost;
  } else {
    const reformulated = await reformulateSearchQuery(ctx.message, ctx.history);
    searchQuery = reformulated.searchQuery;
    method = reformulated.method;
  }

  const hints: string[] = [];
  if (titleBoost && !explicitPage) hints.push(titleBoost);
  if (parsed.personName?.trim()) hints.push(parsed.personName.trim());
  if (parsed.year) hints.push(String(parsed.year));
  if (hints.length && !explicitPage) {
    const hintBlock = hints.join(" ");
    const lower = searchQuery.toLowerCase();
    if (!hints.every((h) => lower.includes(h.toLowerCase()))) {
      searchQuery = `${hintBlock} ${searchQuery}`;
    }
  }

  const searchQueries = SCOPED_RAG_KINDS.has(parsed.kind)
    ? [searchQuery]
    : (await expandSearchQueries(ctx.message, ctx.history, searchQuery)).queries;
  const multiQueryMethod = SCOPED_RAG_KINDS.has(parsed.kind) ? "primary_only" : "llm";

  logChatRoute("semantic_rag", parsed, {
    reformulation: method,
    multi_query: multiQueryMethod,
    search_queries: searchQueries,
  });

  const { context: notionContext, confidence, chunkHits } =
    await buildNotionContextWithConfidence(searchQueries, {
      titleBoost: titleBoost || undefined,
      year: parsed.year,
    });

  logRetrievalDiagnostics(parsed, searchQueries, confidence, chunkHits);

  if (!notionContext.trim()) {
    return jsonAnswer(
      ctx.sessionId,
      "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
    );
  }

  if (!confidence.ok) {
    return jsonAnswer(ctx.sessionId, RETRIEVAL_REFUSAL_MESSAGE);
  }

  return streamGeminiAnswer(ctx.message, notionContext, ctx.history, ctx.sessionId, parsed.kind);
}
