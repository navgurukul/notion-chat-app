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
import { streamOpenAIAnswer } from "@/lib/chat/stream-response";
import { resolveQuery } from "@/lib/query/resolve-query";
import { analyzeUserEmotion } from "@/lib/chat/emotion";
import type { ParsedQuery } from "@/lib/query/types";
import { lookupPageLinkByTitle } from "@/lib/sql/answers";
import {
  extractLastEntityFromHistory,
  jsonAnswer,
  resolveFirstPerson,
  tryFastPathRegexRoute,
} from "./pipeline/router";
import { trySqlAnswer } from "./pipeline/sql";
import { tryRagAnswer } from "./pipeline/rag";
import { PipelineContext, LATENCY_BUDGETS } from "./pipeline/timing";
import { PipelineTelemetry } from "./pipeline/telemetry";
import { detectAndHandleCorrection, isCorrectionMessage } from "./pipeline/correction";
import { detectSmalltalkType, tryFastPathRegexRoute as smalltalkFastPath } from "./pipeline/router";
import type { ChatHistoryItem } from "@/lib/ai/openai";

export type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
  sessionId?: unknown;
  isRegenerate?: boolean;
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
  isRegenerate = false,
): Promise<string | null> {
  if (typeof rawSessionId !== "string" || !rawSessionId.trim()) return null;

  const user = await getOrCreateUser(session);
  const ownsSession = await ensureSessionBelongsToUser(rawSessionId, user.id);
  if (!ownsSession) throw new ChatNotFoundError();

  if (!isRegenerate) {
    await addChatMessage(rawSessionId, "user", message, userEmotion).catch(err =>
      console.error("[DB Write Error] Failed to save user message:", err),
    );
  }
  return rawSessionId;
}

async function tryNotionLinkAnswer(ctx: PipelineContext, emotion?: string, signal?: AbortSignal) {
  // kept identical to previous behavior
  // eslint-disable-next-line @typescript-eslint/no-shadow
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

function countSmalltalkRepeats(history: ChatHistoryItem[], smalltalkType: ReturnType<typeof detectSmalltalkType>, maxUserTurns = 8) {
  if (!smalltalkType) return 0;
  const userTurns = history
    .filter(h => h.role === "user")
    .map(h => h.content)
    .slice(-maxUserTurns);

  return userTurns.filter(t => detectSmalltalkType(t) === smalltalkType).length;
}

function buildSmalltalkWarmPoolFallback(type: ReturnType<typeof detectSmalltalkType>, userName?: string, message?: string) {
  const fast = message ? smalltalkFastPath(message, userName) : null;
  if (fast && fast.kind === "smalltalk") return fast.answer;
  return type
    ? "Hi! What would you like to check in NavGurukul’s Notion today?"
    : "Hi! How can I help you today?";
}

async function tryWarmReplyOrFallback(opts: {
  message: string;
  history: ChatHistoryItem[];
sessionId: string | null;
userName?: string;
    smalltalkType: ReturnType<typeof detectSmalltalkType>;
    userEmotion?: string;
signal?: AbortSignal;
}): Promise<Response> {


  const fallbackAnswer = buildSmalltalkWarmPoolFallback(opts.smalltalkType, opts.userName ?? undefined, opts.message);



  // warm reply via LLM (Gemini) using a short prompt; if anything fails => fallback
  const warmPrompt = `User message: ${opts.message}

Smalltalk type: ${opts.smalltalkType}
${opts.userName ? `Address the user as ${opts.userName}.` : ""}

Write a single short, friendly warm reply (1-2 sentences). Do NOT repeat the exact same response as before.
If relevant, ask a lightweight next question about what they'd like to check in NavGurukul Notion.`;

  try {
      return await streamOpenAIAnswer(
      warmPrompt,
      "",
      opts.history,
      opts.sessionId,
      "smalltalk" as any,
      opts.signal,
      {
        tStart: 0,
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
      opts.userEmotion,
    );
  } catch {
    return jsonAnswer(opts.sessionId, fallbackAnswer, opts.userEmotion, opts.signal);
  }
}

export async function runChatPipeline(session: Session, body: ChatRequestBody, signal?: AbortSignal) {
  const tStart = performance.now();

  const rawMessage = validateMessage(body.message);
  const history = sanitizeChatHistory(body.history);

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;

  const telemetry = new PipelineTelemetry(requestId, sessionId, rawMessage);
  let response: any = null;

  try {
    // 1. Fast-path regex routing (smalltalk only)
    const fastPath = tryFastPathRegexRoute(rawMessage, session.user?.name || undefined);
    if (fastPath) {
      telemetry.setExecutionPath("Smalltalk/Fastpath");
      telemetry.setIntent("smalltalk", 1.0, "regex");

      if (sessionId) {
        try {
          const owns = await ensureSessionBelongsToUser(sessionId, (await getOrCreateUser(session)).id);
          if (owns) {
            if (!body.isRegenerate) {
              await addChatMessage(sessionId, "user", rawMessage, "neutral");
            }

            // repeat detection based on history user messages only
            const stType = detectSmalltalkType(rawMessage);
            const repeats = countSmalltalkRepeats(history, stType);
            if (repeats >= 3) {
              response = await tryWarmReplyOrFallback({
                message: rawMessage,
                history,
                sessionId,
                userName: session.user?.name ?? undefined,
                smalltalkType: stType,

                userEmotion: "neutral",
                signal,
              });
              // ensure bot message persistence if warm reply used fallback jsonAnswer path
              return response;
            }

            await addChatMessage(sessionId, "bot", fastPath.answer, "neutral");
          }
        } catch (err) {
          console.error("[DB Write Error] Failed to save smalltalk messages:", err);
        }
      }

      response = NextResponse.json({ answer: fastPath.answer, emotion: "neutral", sessionId });
      return response;
    }

    // 2. Preprocessing
    telemetry.startStep("emotion_analysis_ms");

    // Fast LLM-friendly utility: current date/time (general question)
    // If user asks “today’s date / what date is it” / “current time” etc., answer without Notion retrieval.
    const utilityDateTimeRegex = /\b(today\s*['’]?\s*s\s+date|today\s+date|today\s+is\s+date|what\s+date\s+is\s+it\s+today|what\s+is\s+today\s*['’]?\s*s\s+date|what\s+day\s+is\s+it\s+today|day\s+today|current\s+time|what\s+time\s+is\s+it|time\s+now|current\s+date)\b/i;

    const lastEntities = await extractLastEntityFromHistory(history);
    const [emotionAnalysis] = await Promise.all([analyzeUserEmotion(rawMessage, history)]);
    const userEmotion = emotionAnalysis.emotion;
    telemetry.endStep("emotion_analysis_ms");

    // Utility response bypasses Notion retrieval.
    if (utilityDateTimeRegex.test(rawMessage)) {
      const now = new Date();
      const isoDate = now.toISOString().slice(0, 10);
      const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
      const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const answer =
        /\b(time\b|what\s+time|current\s+time|time\s+now)/i.test(rawMessage)
          ? `Current time is **${time}** (local to the server).`
          : `Today is **${weekday}**, **${isoDate}** (local to the server).`;

      const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, userEmotion, body.isRegenerate);
      if (attachedSessionId) {
        await addChatMessage(attachedSessionId, "bot", answer, userEmotion).catch(err => console.error("[DB Write Error] Failed to save utility bot message:", err));
      }

      return NextResponse.json({ answer, emotion: userEmotion, sessionId: attachedSessionId });
    }

    telemetry.incrementLlmCalls();

    const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, userEmotion, body.isRegenerate);


    // merge DB state
    let dbStateProject: string | undefined;
    let dbStatePerson: string | undefined;
    if (attachedSessionId) {
      const dbState = await getSessionState(attachedSessionId);
      if (dbState) {
        if (dbState.activeProject?.name) dbStateProject = dbState.activeProject.name;
        if (dbState.activePerson?.name) dbStatePerson = dbState.activePerson.name;
        if (dbState.lastPerson) dbStatePerson = dbState.lastPerson;
        if (dbState.lastProject) dbStateProject = dbState.lastProject;
      }
    }

    const mergedEntities = {
      lastProject: dbStateProject || lastEntities.lastProject,
      lastPerson: dbStatePerson || lastEntities.lastPerson,
    };

    // correction
    let finalQuery = rawMessage;
    let isWrongAnswerRetry = false;
    const correction = await detectAndHandleCorrection(rawMessage, history, attachedSessionId, {
      lastPerson: mergedEntities.lastPerson,
      lastProject: mergedEntities.lastProject,
    });

    if (correction) {
      if (correction.clarifyingQuestion) {
        return jsonAnswer(attachedSessionId, correction.clarifyingQuestion, userEmotion, signal);
      }
      if (correction.rewrittenMessage) {
        finalQuery = correction.rewrittenMessage;
        if (correction.correctedPerson) mergedEntities.lastPerson = correction.correctedPerson;
        if (correction.correctedProject) mergedEntities.lastProject = correction.correctedProject;
      }
      if (correction.isWrongAnswerRetry) isWrongAnswerRetry = true;
    }

    const saveState = async () => {
      if (!attachedSessionId) return;
      const resolvedEntities = telemetry.getTrace().entities;
      const currentState = (await getSessionState(attachedSessionId)) || {};
      let changed = false;

      if (resolvedEntities) {
        if (
          resolvedEntities.person?.value &&
          resolvedEntities.person.confidence &&
          resolvedEntities.person.confidence >= 0.7
        ) {
          currentState.activePerson = {
            id: resolvedEntities.person.value,
            name: resolvedEntities.person.value,
            confidence: resolvedEntities.person.confidence,
            source: "retrieval",
          };
          currentState.lastPerson = resolvedEntities.person.value;
          changed = true;
        } else if (parsed?.personName) {
          currentState.lastPerson = parsed.personName;
          changed = true;
        }
        if (resolvedEntities.page?.value) {
          currentState.activeProject = {
            id: resolvedEntities.page.value,
            name: resolvedEntities.page.value,
            confidence: resolvedEntities.page.quality === "EXACT" ? 1.0 : 0.85,
            source: "retrieval",
          };
          currentState.lastProject = resolvedEntities.page.value;
          changed = true;
        } else if (parsed?.docTitle) {
          currentState.lastProject = parsed.docTitle;
          changed = true;
        }
      } else {
        if (parsed?.personName) {
          currentState.lastPerson = parsed.personName;
          changed = true;
        }
        if (parsed?.docTitle) {
          currentState.lastProject = parsed.docTitle;
          changed = true;
        }
      }

      if (currentState.lastRewrittenQuery !== finalQuery) {
        currentState.lastRewrittenQuery = finalQuery;
        changed = true;
      }

      if (finalQuery === rawMessage && !isCorrectionMessage(rawMessage)) {
        currentState.lastUserQueryPreCorrection = rawMessage;
        changed = true;
      }

      if (changed) await updateSessionState(attachedSessionId, currentState);
    };

    // 3. Intent classification
    telemetry.startStep("intent_classifier_ms");
    const parsed = await resolveQuery(finalQuery, history, session.user?.name || undefined, mergedEntities);
    telemetry.endStep("intent_classifier_ms");
    telemetry.setIntent(parsed.kind, parsed.confidence, parsed.source);
    if (parsed.source !== "regex") telemetry.incrementLlmCalls();

    const ctx: PipelineContext = {
      message: finalQuery,
      history,
      sessionId: attachedSessionId,
      lastProject: mergedEntities.lastProject,
      lastPerson: mergedEntities.lastPerson,
      sessionName: session.user?.name || undefined,
      reformulatedQuery: parsed.reformulatedQuery,
      telemetry,
      isWrongAnswerRetry,
    };

    // 6. Notion link
    const linkResponse = await tryNotionLinkAnswer(ctx, userEmotion, signal);
    if (linkResponse) {
      telemetry.setExecutionPath("Notion Link");
      response = linkResponse;
      return response;
    }

    // 7. Smalltalk (non-fastpath)
    if (parsed.kind === "smalltalk") {
      const stType = detectSmalltalkType(rawMessage);
      const repeats = countSmalltalkRepeats(history, stType);

      telemetry.setExecutionPath("Smalltalk/Fastpath");
      telemetry.incrementLlmCalls();

      if (attachedSessionId) await saveState().catch(err => console.error("Error saving session state:", err));

      // warm reply on 3rd+ repeats; fallback to variation pool answer
      if (repeats >= 3) {
        return await tryWarmReplyOrFallback({
          message: rawMessage,
          history,
          sessionId: attachedSessionId,
          userName: session.user?.name ?? undefined,
          smalltalkType: stType,

          userEmotion,
          signal,
        });
      }

      response = await streamOpenAIAnswer(
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
        userEmotion,
      );
      return response;
    }

    // 8. SQL
    telemetry.startStep("sql_ms");
    const sqlResponse = await trySqlAnswer(parsed, ctx, userEmotion, signal, {
      tStart,
      dNormalization: 0,
      dResolveQuery: 0,
    });
    telemetry.endStep("sql_ms");

    if (sqlResponse) {
      telemetry.setExecutionPath("SQL Hit");
      if (attachedSessionId) await saveState().catch(err => console.error("Error saving session state:", err));
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

    // 9. RAG
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

    if (attachedSessionId) await saveState().catch(err => console.error("Error saving session state:", err));
    response = ragResponse;
    return response;
  } finally {
    telemetry.finish();
  }
}

