import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import {
  addChatMessage,
  ensureSessionBelongsToUser,
  getOrCreateUser,
  getSessionState,
  updateSessionState,
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
import { PipelineTelemetry } from "./pipeline/telemetry";

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

  await addChatMessage(rawSessionId, "user", message, userEmotion)
    .catch(err => console.error("[DB Write Error] Failed to save user message:", err));
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

// logPipelineTelemetry is now handled via the PipelineTelemetry helper class.

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

  const telemetry = new PipelineTelemetry(requestId, sessionId, rawMessage);
  let response: any = null;

  try {
    // 1. Fast-path regex routing
    const fastPath = tryFastPathRegexRoute(rawMessage);
    if (fastPath) {
      telemetry.setExecutionPath("Smalltalk/Fastpath");
      telemetry.setIntent("smalltalk", 1.0, "regex");
      
      if (sessionId) {
        try {
          const user = await getOrCreateUser(session);
          const ownsSession = await ensureSessionBelongsToUser(sessionId, user.id);
          if (ownsSession) {
            await addChatMessage(sessionId, "user", rawMessage, "neutral");
            await addChatMessage(sessionId, "bot", fastPath.answer, "neutral");
          }
        } catch (err) {
          console.error("[DB Write Error] Failed to save smalltalk messages:", err);
        }
      }
      response = NextResponse.json({ answer: fastPath.answer, emotion: "neutral", sessionId });
      return response;
    }

    // 2. Parallel Preprocessing
    telemetry.startStep("emotion_analysis_ms");
    const lastEntities = await extractLastEntityFromHistory(history);
    const [emotionAnalysis] = await Promise.all([
      analyzeUserEmotion(rawMessage, history),
    ]);
    const userEmotion = emotionAnalysis.emotion;
    telemetry.endStep("emotion_analysis_ms");
    telemetry.incrementLlmCalls();

    const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, userEmotion);

    // Merge DB active state if available
    let dbStateProject: string | undefined;
    let dbStatePerson: string | undefined;
    if (attachedSessionId) {
      const dbState = await getSessionState(attachedSessionId);
      if (dbState) {
        if (dbState.activeProject?.name) {
          dbStateProject = dbState.activeProject.name;
        }
        if (dbState.activePerson?.name) {
          dbStatePerson = dbState.activePerson.name;
        }
      }
    }

    const mergedEntities = {
      lastProject: dbStateProject || lastEntities.lastProject,
      lastPerson: dbStatePerson || lastEntities.lastPerson,
    };

    // Helper to asynchronously save state
    const saveState = async () => {
      if (attachedSessionId) {
        const resolvedEntities = telemetry.getTrace().entities;
        if (resolvedEntities) {
          const currentState = await getSessionState(attachedSessionId) || {};
          let changed = false;

          if (resolvedEntities.person?.value && resolvedEntities.person.confidence && resolvedEntities.person.confidence >= 0.7) {
            currentState.activePerson = {
              id: resolvedEntities.person.value,
              name: resolvedEntities.person.value,
              confidence: resolvedEntities.person.confidence,
              source: "retrieval"
            };
            currentState.lastPerson = resolvedEntities.person.value;
            changed = true;
          }
          if (resolvedEntities.page?.value) {
            currentState.activeProject = {
              id: resolvedEntities.page.value,
              name: resolvedEntities.page.value,
              confidence: resolvedEntities.page.quality === "EXACT" ? 1.0 : 0.85,
              source: "retrieval"
            };
            currentState.lastProject = resolvedEntities.page.value;
            changed = true;
          }

          if (changed) {
            await updateSessionState(attachedSessionId, currentState);
          }
        }
      }
    };

    // 3. Intent Classification (runs first, on the raw query)
    telemetry.startStep("intent_classifier_ms");
    let parsed = await resolveQuery(rawMessage, history, session.user?.name || undefined, mergedEntities);
    telemetry.endStep("intent_classifier_ms");
    telemetry.setIntent(parsed.kind, parsed.confidence, parsed.source);
    if (parsed.source !== "regex") {
      telemetry.incrementLlmCalls();
    }

    // 4. Construct Context
    const ctx: PipelineContext = {
      message: rawMessage,
      history,
      sessionId: attachedSessionId,
      lastProject: mergedEntities.lastProject,
      lastPerson: mergedEntities.lastPerson,
      sessionName: session.user?.name || undefined,
      reformulatedQuery: parsed.reformulatedQuery,
      telemetry
    };

    // 6. Try Notion Link Answer
    const linkResponse = await tryNotionLinkAnswer(ctx, userEmotion, signal);
    if (linkResponse) {
      telemetry.setExecutionPath("Notion Link");
      response = linkResponse;
      return response;
    }

    // 7. Smalltalk (non-fastpath)
    if (parsed.kind === "smalltalk") {
      telemetry.setExecutionPath("Smalltalk/Fastpath");
      telemetry.incrementLlmCalls();
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
          intentClassification: 0,
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
    telemetry.startStep("sql_ms");
    const sqlResponse = await trySqlAnswer(parsed, ctx, userEmotion, signal, {
      tStart,
      dNormalization: 0,
      dResolveQuery: 0,
    });
    telemetry.endStep("sql_ms");

    if (sqlResponse) {
      telemetry.setExecutionPath("SQL Hit");
      if (attachedSessionId) {
        saveState().catch(err => console.error("Error saving session state:", err));
      }
      response = sqlResponse;
      return response;
    }

    if (isNotionLinkRequest(rawMessage)) {
      telemetry.setExecutionPath("Notion Link");
      response = jsonAnswer(
        attachedSessionId,
        "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.",
        userEmotion,
        signal,
      );
      return response;
    }

    // 9. RAG lane
    telemetry.startStep("rag_ms");
    const ragResponse = await tryRagAnswer(parsed, ctx, session, {
      tStart,
      dNormalization: 0,
      dResolveQuery: 0,
      dReformulate: 0,
      dSqlAnswer: 0,
    }, signal, userEmotion);
    telemetry.endStep("rag_ms");
    telemetry.setExecutionPath("RAG Fallback");

    if (attachedSessionId) {
      saveState().catch(err => console.error("Error saving session state:", err));
    }
    response = ragResponse;
    return response;
  } finally {
    telemetry.finish();
  }
}
