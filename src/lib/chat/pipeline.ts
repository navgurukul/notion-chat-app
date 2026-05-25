import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { addChatMessage, ensureSessionBelongsToUser, getOrCreateUser } from "@/lib/chat/store";
import { MAX_MESSAGE_LENGTH, STRUCTURED_QUERY_KINDS } from "@/lib/chat/constants";
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
import {
  handleMetadataQuery,
  isWeakProjectEtaAnswer,
  lookupPageLinkByTitle,
} from "@/lib/sql/answers";
import { buildNotionContextForChat } from "@/lib/rag/build-context";

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
export async function runChatPipeline(session: Session, body: ChatRequestBody) {
  const message = validateMessage(body.message);
  const sessionId = await attachSession(session, body.sessionId, message);
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

  return tryRagAnswer(parsed, ctx);
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

  const directAnswer = await handleMetadataQuery(parsed);
  if (directAnswer) {
    if (parsed.kind === "project_eta" && isWeakProjectEtaAnswer(directAnswer)) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[chat] mode=project_eta search=sql_weak fallback=semantic");
      }
    } else {
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[chat] mode=${parsed.kind} search=sql_direct answer_chars=${directAnswer.length}`,
        );
      }
      return jsonAnswer(ctx.sessionId, directAnswer);
    }
  }

  if (STRUCTURED_QUERY_KINDS.has(parsed.kind) && parsed.docTitle?.trim()) {
    return jsonAnswer(
      ctx.sessionId,
      `I couldn't find **${parsed.docTitle.trim()}** in the synced Notion database. Use **Sync changes** in the sidebar, then try again.`,
    );
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[chat] mode=${parsed.kind} search=sql_empty fallback=semantic`);
  }

  return null;
}

async function tryRagAnswer(parsed: ParsedQuery, ctx: PipelineContext) {
  const { searchQuery: reformulated, method } = await reformulateSearchQuery(
    ctx.message,
    ctx.history,
  );

  let searchQuery = reformulated;
  if (parsed.kind === "semantic" && parsed.docTitle?.trim()) {
    const title = parsed.docTitle.trim();
    const lower = searchQuery.toLowerCase();
    if (!lower.includes(title.toLowerCase())) {
      searchQuery = `${title} ${searchQuery}`;
    }
  }

  const { queries: searchQueries, method: multiQueryMethod } = await expandSearchQueries(
    ctx.message,
    ctx.history,
    searchQuery,
  );

  if (process.env.NODE_ENV !== "production") {
    console.log("[chat] retrieval_query", {
      method,
      multi_query: multiQueryMethod,
      search_queries: searchQueries,
    });
  }

  const notionContext = await buildNotionContextForChat(searchQueries);
  if (!notionContext.trim()) {
    return jsonAnswer(
      ctx.sessionId,
      "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
    );
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[chat] mode=semantic context_chars=${notionContext.length}`);
  }

  return streamGeminiAnswer(ctx.message, notionContext, ctx.history, ctx.sessionId);
}
