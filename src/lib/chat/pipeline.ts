import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import {
  addChatMessage,
  ensureSessionBelongsToUser,
  getOrCreateUser,
} from "@/lib/chat/store";
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
import { detectIntent } from "@/lib/query/intent";
import { extractYear } from "@/lib/query/year";
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
import {
  logChatRoute,
  logRetrievalDiagnostics,
} from "@/lib/chat/retrieval-diagnostics";
import { buildNotionContextWithConfidence } from "@/lib/rag/build-context";
import { RETRIEVAL_REFUSAL_MESSAGE } from "@/lib/rag/retrieval-confidence";
import { normalizeLanguage } from "@/lib/chat/normalize-language";
import { resolvePersonName } from "@/lib/db/team-members";

function stripTitleEmoji(title: string) {
  return title
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  return message
    .toLowerCase()
    .includes(needle.slice(0, Math.min(needle.length, 24)));
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

async function resolveFirstPerson(
  message: string,
  session: Session,
): Promise<{ message: string; ambiguous?: string[] }> {
  const hasPronoun = /\b(me|my|myself|I)\b/i.test(message);
  if (!hasPronoun) return { message };

  const fullName = session?.user?.name?.trim();
  if (!fullName) return { message };

  const { exact, candidates } = await resolvePersonName(fullName);

  if (candidates.length > 1) {
    return { message, ambiguous: candidates };
  }

  const resolvedName = exact ?? fullName.split(/\s+/)[0];
  return {
    message: message.replace(/\b(me|my|myself|I)\b/g, resolvedName),
  };
}

function extractLastEntityFromHistory(history: ChatHistoryItem[]): {
  lastProject?: string;
  lastPerson?: string;
} {
  const recentHistory = [...history].reverse().slice(0, 6);

  for (const item of recentHistory) {
    const content = item.content;
    const boldMatches = [...content.matchAll(/\*\*([^*]{2,60})\*\*/g)];

    // Pattern 1: "X is assigned to: Person" → lastProject = X
    const assignedToMatch = content.match(
      /\*\*[""]?([^*"]{4,60})[""]?\*\*\s+is assigned to/i,
    );
    if (assignedToMatch?.[1]) {
      return { lastProject: assignedToMatch[1].trim() };
    }

    // Pattern 2: "about X", "objective of X", "tell me about X"
    const aboutMatch = content.match(
      /(?:about|objective of|overview of|summary of)\s+(?:the\s+)?\*\*([^*]{4,60})\*\*/i,
    );
    if (aboutMatch?.[1]) {
      return { lastProject: aboutMatch[1].trim() };
    }

    // Pattern 3: Bold title near project keywords
    for (const match of boldMatches) {
      const candidate = match[1].trim();

      if (
        /^(status|owner|done|backlog|unknown|open|closed|in progress|testing|blocked|not started|sync changes)$/i.test(
          candidate,
        )
      )
        continue;
      if (candidate.split(/\s+/).length > 6) continue;
      if (candidate.length < 3) continue;

      const surrounding = content.slice(
        Math.max(0, (match.index ?? 0) - 50),
        (match.index ?? 0) + 100,
      );

      if (
        /project|status|working|owner|summary|about|assigned|scope|objective|maintaining|backlog|development/i.test(
          surrounding,
        )
      ) {
        return { lastProject: candidate };
      }
    }

    // Pattern 4: Person near ownership label
    for (const match of boldMatches) {
      const candidate = match[1].trim();
      const surrounding = content.slice(
        Math.max(0, (match.index ?? 0) - 40),
        (match.index ?? 0) + 80,
      );
      if (
        /\b(owner|assignee|created by|assigned to|working on)\b/i.test(
          surrounding,
        )
      ) {
        if (candidate.split(/\s+/).length <= 3 && candidate.length >= 3) {
          return { lastPerson: candidate };
        }
      }
    }
  }

  return {};
}

export async function runChatPipeline(
  session: Session,
  body: ChatRequestBody,
  signal?: AbortSignal,
) {
  const rawMessage = validateMessage(body.message);
  const sessionId = await attachSession(session, body.sessionId, rawMessage);

  const normalized = await normalizeLanguage(rawMessage);
  const { message, ambiguous } = await resolveFirstPerson(normalized, session);

  if (ambiguous?.length) {
    return jsonAnswer(
      sessionId,
      `Multiple people named **${session.user?.name}** found in Notion:\n${ambiguous
        .map((n) => `- ${n}`)
        .join("\n")}\n\nWhich one did you mean?`,
    );
  }

  const history = sanitizeChatHistory(body.history);
  const ctx: PipelineContext = { message, history, sessionId };

  const linkResponse = await tryNotionLinkAnswer(ctx);
  if (linkResponse) return linkResponse;

  const parsed = await resolveQuery(message);
  console.log("[query_debug]", {
    query: message,
    intent: detectIntent(message),
    year: extractYear(message),
    resolvedPerson: parsed.personName ?? null,
    resolvedProject: parsed.docTitle ?? null,
  });
  logParsedQuery(parsed);

  const sqlResponse = await trySqlAnswer(parsed, ctx);
  if (sqlResponse) return sqlResponse;

  if (isNotionLinkRequest(message)) {
    return jsonAnswer(
      sessionId,
      "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.",
    );
  }

  return tryRagAnswer(parsed, ctx, session, signal);
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
    if (
      parsed.kind === "team_activity" &&
      isTeamActivityMetadataGap(directAnswer)
    ) {
      logChatRoute("sql_weak_rag", parsed, {
        team_activity_metadata_gap: true,
      });
      return null;
    }
    logChatRoute("sql_miss_metadata", parsed, {
      had_sql: Boolean(directAnswer),
    });
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

async function tryRagAnswer(
  parsed: ParsedQuery,
  ctx: PipelineContext,
  session: Session,
  signal?: AbortSignal,
) {
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

  // Follow-up context resolution from history
  const { lastProject, lastPerson } = extractLastEntityFromHistory(ctx.history);

  const isVagueFollowUp =
    !parsed.docTitle &&
    !parsed.personName &&
    /\b(this|that|it|more|explain|project|core|detail|in depth|elaborate|tell me more|what about|only for|for \d{4}|in \d{4}|more information|more about|about it)\b/i.test(
      ctx.message,
    ) &&
    ctx.message.trim().split(/\s+/).length < 12;

  if (isVagueFollowUp) {
    if (lastProject && !titleBoost) {
      searchQuery = `${lastProject} ${searchQuery}`.trim();
      method = "history_entity";
    } else if (lastPerson && !parsed.personName) {
      searchQuery = `${lastPerson} ${searchQuery}`.trim();
      method = "history_entity";
    }
  }

  const searchQueries = SCOPED_RAG_KINDS.has(parsed.kind)
    ? [searchQuery]
    : (await expandSearchQueries(ctx.message, ctx.history, searchQuery))
        .queries;
  const multiQueryMethod = SCOPED_RAG_KINDS.has(parsed.kind)
    ? "primary_only"
    : "llm";

  logChatRoute("semantic_rag", parsed, {
    reformulation: method,
    multi_query: multiQueryMethod,
    search_queries: searchQueries,
    history_entity: isVagueFollowUp ? { lastProject, lastPerson } : undefined,
  });

  const {
    context: notionContext,
    confidence,
    chunkHits,
  } = await buildNotionContextWithConfidence(searchQueries, {
    titleBoost: titleBoost || undefined,
    year: parsed.year,
  });

  logRetrievalDiagnostics(parsed, searchQueries, confidence, chunkHits);

  // Telemetry
  console.log(
    "[telemetry]",
    JSON.stringify({
      kind: parsed.kind,
      expandedQueryCount: searchQueries.length,
      contextChars: notionContext.length,
      topScore: confidence.topScore,
      avgScore: confidence.avgScore,
      confidenceOk: confidence.ok,
      historyEntityUsed: isVagueFollowUp && (!!lastProject || !!lastPerson),
      ts: Date.now(),
    }),
  );

  if (!notionContext.trim()) {
    return jsonAnswer(
      ctx.sessionId,
      "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
    );
  }

  if (!confidence.ok) {
    return jsonAnswer(ctx.sessionId, RETRIEVAL_REFUSAL_MESSAGE);
  }

  return streamGeminiAnswer(
    ctx.message,
    notionContext,
    ctx.history,
    ctx.sessionId,
    parsed.kind,
    signal,
  );
}
