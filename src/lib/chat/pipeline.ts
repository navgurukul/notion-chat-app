import { NextResponse } from "next/server";
import type { Session } from "next-auth";
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
import { reformulateSearchQuery } from "@/lib/chat/query-reformulation";
import { streamGeminiAnswer } from "@/lib/chat/stream-response";
import { resolveQuery } from "@/lib/query/resolve-query";
import { detectIntent } from "@/lib/query/intent";
import { analyzeUserEmotion } from "@/lib/chat/emotion";
import { extractYear } from "@/lib/query/year";
import type { ParsedQuery } from "@/lib/query/types";
import { lookupPageLinkByTitle } from "@/lib/sql/answers";
import { normalizeLanguage } from "@/lib/chat/normalize-language";
import {
  tryFastPathRegexRoute,
  resolveFirstPerson,
  isFollowUpQuery,
  extractLastEntityFromHistory,
  jsonAnswer,
} from "./pipeline/router";
import { trySqlAnswer } from "./pipeline/sql";
import { tryRagAnswer } from "./pipeline/rag";
import { PipelineContext, PipelineTrace, LATENCY_BUDGETS } from "./pipeline/timing";

export type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
  sessionId?: unknown;
};

export class ChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

function validateMessage(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ChatValidationError("Message is required");
  }
  return raw.trim().slice(0, MAX_MESSAGE_LENGTH);
}

async function attachSession(
  session: Session,
  rawSessionId: unknown,
  message: string,
  userEmotion?: string,
): Promise<string | null> {
  if (typeof rawSessionId !== "string" || !rawSessionId.trim()) return null;

  const user = await getOrCreateUser(session);
  const ownsSession = await ensureSessionBelongsToUser(rawSessionId, user.id);
  if (!ownsSession) throw new ChatNotFoundError();

  await addChatMessage(rawSessionId, "user", message, userEmotion);
  return rawSessionId;
}

async function tryNotionLinkAnswer(ctx: PipelineContext, emotion?: string, signal?: AbortSignal) {
  if (!isNotionLinkRequest(ctx.message)) return null;

  const linkTitle = extractReferencedTitle(ctx.message, ctx.history);
  if (linkTitle) {
    const linkAnswer = await lookupPageLinkByTitle(linkTitle);
    if (linkAnswer) return jsonAnswer(ctx.sessionId, linkAnswer, emotion, signal);
    return jsonAnswer(
      ctx.sessionId,
      `I couldn't find a synced Notion page titled **${linkTitle}**. Use **Sync changes**, or ask with the exact page title from Notion.`,
      emotion,
      signal,
    );
  }

  if (/\b(it|this|that)\b/i.test(ctx.message)) {
    const unresolved =
      ctx.history.length > 0
        ? "I couldn't resolve which page you mean from chat history. Ask again with the full page title, e.g. link for **Structuring the Product Team**."
        : "I couldn't resolve which page you mean — include the page title, or ask about a page first so chat history has context.";
    return jsonAnswer(ctx.sessionId, unresolved, emotion, signal);
  }

  return null;
}

function logPipelineTelemetry(trace: PipelineTrace) {
  const now = Date.now();
  trace.durations.total_ms = Math.round(now - new Date(trace.timestamp).getTime());
  
  // Flag budget violations
  const budgetWarnings: string[] = [];
  for (const [stage, budget] of Object.entries(LATENCY_BUDGETS)) {
    const elapsed = trace.durations[stage as keyof typeof trace.durations];
    if (elapsed !== undefined && elapsed > budget) {
      budgetWarnings.push(`${stage} exceeded budget (${elapsed}ms > ${budget}ms)`);
    }
  }

  const logPayload = {
    ...trace,
    budgetWarnings: budgetWarnings.length ? budgetWarnings : undefined
  };

  // Structured JSON Log
  console.log("[pipeline-telemetry]", JSON.stringify(logPayload));

  // Pretty-print in development
  if (process.env.NODE_ENV !== "production") {
    console.log("\n================ PIPELINE TRACE ================");
    console.log(`Request ID: ${trace.requestId}`);
    console.log(`Query: ${trace.originalQuery}`);
    console.log(`Intent: ${trace.intentRoute?.kind} (conf: ${trace.intentRoute?.confidence}, src: ${trace.intentRoute?.source})`);
    console.log(`Execution Path: ${trace.executionPath}`);
    console.log("Durations (ms):", trace.durations);
    if (budgetWarnings.length) {
      console.warn("⚠️ Latency Warnings:", budgetWarnings);
    }
    console.log("================================================\n");
  }
}

export async function runChatPipeline(
  session: Session,
  body: ChatRequestBody,
  signal?: AbortSignal,
) {
  const tStart = performance.now();

  const rawMessage = validateMessage(body.message);
  const history = sanitizeChatHistory(body.history);

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;

  const trace: PipelineTrace = {
    requestId,
    sessionId,
    timestamp: new Date().toISOString(),
    originalQuery: rawMessage,
    durations: {}
  };

  let response: any = null;

  try {
    // 1. Fast-path regex routing
    const fastPath = tryFastPathRegexRoute(rawMessage);
    if (fastPath) {
      trace.executionPath = "Smalltalk/Fastpath";
      trace.intentRoute = { kind: "smalltalk", confidence: 1.0, source: "regex" };
      
      if (sessionId) {
        const user = await getOrCreateUser(session);
        const ownsSession = await ensureSessionBelongsToUser(sessionId, user.id);
        if (ownsSession) {
          await addChatMessage(sessionId, "user", rawMessage, "neutral");
          await addChatMessage(sessionId, "bot", fastPath.answer, "neutral");
        }
      }
      response = NextResponse.json({ answer: fastPath.answer, emotion: "neutral", sessionId });
      return response;
    }

    // 2. Parallel Preprocessing
    const lastEntities = await extractLastEntityFromHistory(history);
    const [emotionAnalysis] = await Promise.all([
      analyzeUserEmotion(rawMessage, history),
    ]);
    const userEmotion = emotionAnalysis.emotion;

    const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, userEmotion);

    // 3. Intent Classification (runs first, on the raw query)
    const tIntentStart = performance.now();
    let parsed = await resolveQuery(rawMessage, history, session.user?.name || undefined, lastEntities);
    const dIntentClassify = performance.now() - tIntentStart;
    trace.intentRoute = { kind: parsed.kind, confidence: parsed.confidence, source: parsed.source };
    trace.durations.intent_classifier_ms = Math.round(dIntentClassify);

    // 4. Construct Context
    const ctx: PipelineContext = {
      message: rawMessage,
      history,
      sessionId: attachedSessionId,
      lastProject: lastEntities.lastProject,
      lastPerson: lastEntities.lastPerson,
      sessionName: session.user?.name || undefined,
      reformulatedQuery: parsed.reformulatedQuery,
      trace
    };

    // 6. Try Notion Link Answer
    const linkResponse = await tryNotionLinkAnswer(ctx, userEmotion, signal);
    if (linkResponse) {
      trace.executionPath = "Notion Link";
      response = linkResponse;
      return response;
    }

    // 7. Smalltalk (non-fastpath)
    if (parsed.kind === "smalltalk") {
      trace.executionPath = "Smalltalk/Fastpath";
      response = await streamGeminiAnswer(
        ctx.message,
        "",
        ctx.history,
        ctx.sessionId,
        parsed.kind,
        signal,
        {
          tStart,
          normalization: 0,
          intentClassification: Math.round(dIntentClassify),
          sqlAnswerAttempt: 0,
          queryReformulation: 0,
          queryExpansion: 0,
          retrieval: 0,
          expandedQueryCount: 0,
          contextChars: 0,
          topScore: 0,
          avgScore: 0,
          confidenceOk: true,
          historyEntityUsed: false,
        },
        userEmotion
      );
      return response;
    }

    // 8. SQL Metadata lane
    const tSqlStart = performance.now();
    const sqlResponse = await trySqlAnswer(parsed, ctx, userEmotion, signal, {
      tStart,
      dNormalization: 0,
      dResolveQuery: dIntentClassify,
    });
    const dSqlAnswer = performance.now() - tSqlStart;
    trace.durations.sql_ms = Math.round(dSqlAnswer);

    if (sqlResponse) {
      trace.executionPath = "SQL Hit";
      response = sqlResponse;
      return response;
    }

    if (isNotionLinkRequest(rawMessage)) {
      trace.executionPath = "Notion Link";
      response = jsonAnswer(
        attachedSessionId,
        "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.",
        userEmotion,
        signal,
      );
      return response;
    }

    // 9. RAG lane
    const tRagStart = performance.now();
    const ragResponse = await tryRagAnswer(parsed, ctx, session, {
      tStart,
      dNormalization: 0,
      dResolveQuery: dIntentClassify,
      dReformulate: 0,
      dSqlAnswer,
    }, signal, userEmotion);
    const dRagAnswer = performance.now() - tRagStart;
    trace.durations.rag_ms = Math.round(dRagAnswer);
    trace.executionPath = "RAG Fallback";

    response = ragResponse;
    return response;
  } finally {
    logPipelineTelemetry(trace);
  }
}
