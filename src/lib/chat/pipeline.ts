import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import {
  addChatMessage,
  ensureSessionBelongsToUser,
  getOrCreateUser,
  getSessionState,
  updateSessionState,
} from "@/lib/chat/store";
import {
  sanitizeChatHistory,
  extractReferencedTitle,
  isNotionLinkRequest,
} from "@/lib/chat/query-tools";
import { resolveQuery } from "@/lib/query/resolve-query";
import { getGenderOfPerson } from "@/lib/query/entity-resolver";
import { lookupPageLinkByTitle } from "@/lib/sql/answers";
import { buildNotionContextWithConfidence, extractContextPageLinks } from "@/lib/rag/build-context";
import { extractLastEntityFromHistory, jsonAnswer, tryFastPathRegexRoute } from "./smalltalk";
import { trySqlAnswer } from "./sql-answer";
import { tryRagAnswer } from "./rag-answer";
import { PipelineContext, PipelineTelemetry, LATENCY_BUDGETS } from "./telemetry";

const MAX_MESSAGE_LENGTH = 2000;

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

function getSessionDisplayName(session: Session) {
  const name = session.user?.name?.trim();
  if (name) return name;

  const email = session.user?.email?.trim().toLowerCase();
  if (!email) return undefined;

  const localPart = email.split("@")[0] ?? "";
  if (!localPart) return undefined;

  return localPart
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
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
  if (!isNotionLinkRequest(ctx.message)) return null;

  const linkTitle = extractReferencedTitle(ctx.message, ctx.history);
  if (linkTitle) {
    const linkAnswer = await lookupPageLinkByTitle(linkTitle);
    if (linkAnswer) return jsonAnswer(ctx.sessionId, linkAnswer, emotion, signal);

    // Fall back to semantic retrieval for descriptive or misspelled link
    // requests that don't contain the page's exact title.
    const search = await buildNotionContextWithConfidence(
      [linkTitle, ctx.message],
      { originalQuestion: ctx.message },
    );
    const links = extractContextPageLinks(search.context).slice(0, 3);
    if (links.length === 1) {
      return jsonAnswer(
        ctx.sessionId,
        `Closest matching Notion page: **${links[0].title}**\n\n[Open in Notion](${links[0].url})`,
        emotion,
        signal,
      );
    }
    if (links.length > 1) {
      return jsonAnswer(
        ctx.sessionId,
        `I couldn't identify one exact page, but these are the closest matches:\n\n${links.map((link) => `- [${link.title}](${link.url})`).join("\n")}`,
        emotion,
        signal,
      );
    }
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


export async function runChatPipeline(session: Session, body: ChatRequestBody, signal?: AbortSignal) {
  const tStart = performance.now();

  const rawMessage = validateMessage(body.message);
  const history = sanitizeChatHistory(body.history);
  const sessionDisplayName = getSessionDisplayName(session);

  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;

  const telemetry = new PipelineTelemetry(requestId, sessionId, rawMessage);
  let response: any = null;

  try {
    // 1. Fast-path regex routing (smalltalk only)
    const fastPath = tryFastPathRegexRoute(rawMessage, sessionDisplayName || undefined);
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

            await addChatMessage(sessionId, "bot", fastPath.answer, "neutral");
          }
        } catch (err) {
          console.error("[DB Write Error] Failed to save smalltalk messages:", err);
        }
      }

      response = NextResponse.json({ answer: fastPath.answer, emotion: "neutral", sessionId });
      return response;
    }

    const identityQuestion = /^(?:who\s+(?:am\s+i|is\s+me)|what\s+is\s+my\s+name|identify\s+me|who\s+do\s+you\s+think\s+i\s+am)[?.!\s]*$/i;
    if (identityQuestion.test(rawMessage)) {
      const answer = sessionDisplayName
        ? `You are **${sessionDisplayName}**.`
        : "I can’t see a display name for your session yet.";

      const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, "neutral", body.isRegenerate);
      if (attachedSessionId) {
        await addChatMessage(attachedSessionId, "bot", answer, "neutral").catch(err =>
          console.error("[DB Write Error] Failed to save identity bot message:", err),
        );
      }

      return NextResponse.json({ answer, emotion: "neutral", sessionId: attachedSessionId });
    }

    // 2. Preprocessing

    // Fast LLM-friendly utility: current date/time (general question)
    const utilityDateTimeRegex = /\b(today\s*['’]?\s*s\s+date|today\s+date|today\s+is\s+date|what\s+date\s+is\s+it\s+today|what\s+is\s+today\s*['’]?\s*s\s+date|what\s+day\s+is\s+it\s+today|day\s+today|current\s+time|what\s+time\s+is\s+it|time\s+now|current\s+date)\b/i;

    if (utilityDateTimeRegex.test(rawMessage)) {
      const now = new Date();
      const isoDate = now.toISOString().slice(0, 10);
      const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
      const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const answer =
        /\b(time\b|what\s+time|current\s+time|time\s+now)/i.test(rawMessage)
          ? `Current time is **${time}** (local to the server).`
          : `Today is **${weekday}**, **${isoDate}** (local to the server).`;

      const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, "neutral", body.isRegenerate);
      if (attachedSessionId) {
        await addChatMessage(attachedSessionId, "bot", answer, "neutral").catch(err => console.error("[DB Write Error] Failed to save utility bot message:", err));
      }

      return NextResponse.json({ answer, emotion: "neutral", sessionId: attachedSessionId });
    }

    const attachedSessionId = await attachSession(session, body.sessionId, rawMessage, "neutral", body.isRegenerate);

    // merge DB state
    let dbStateProject: string | undefined;
    let dbStatePerson: string | undefined;
    let dbStateLastMale: string | undefined;
    let dbStateLastFemale: string | undefined;
    let dbStateHasEntity = false;
    if (attachedSessionId) {
      const dbState = await getSessionState(attachedSessionId);
      if (dbState) {
        if (dbState.activeProject?.name) dbStateProject = dbState.activeProject.name;
        if (dbState.activePerson?.name) dbStatePerson = dbState.activePerson.name;
        if (dbState.lastPerson) dbStatePerson = dbState.lastPerson;
        if (dbState.lastProject) dbStateProject = dbState.lastProject;
        if (dbState.lastMale) dbStateLastMale = dbState.lastMale;
        if (dbState.lastFemale) dbStateLastFemale = dbState.lastFemale;
        dbStateHasEntity = Boolean(dbStateProject || dbStatePerson || dbStateLastMale || dbStateLastFemale);
      }
    }

    const lastEntities = dbStateHasEntity ? {} : await extractLastEntityFromHistory(history);

    const mergedEntities = {
      lastProject: dbStateProject || lastEntities.lastProject,
      lastPerson: dbStatePerson || lastEntities.lastPerson,
      lastMale: dbStateLastMale,
      lastFemale: dbStateLastFemale,
    };

    const finalQuery = rawMessage;

    // 3. Intent classification & emotion resolution in parallel
    telemetry.startStep("intent_classifier_ms");
    const parsedPromise = resolveQuery(finalQuery, history, sessionDisplayName || undefined, mergedEntities);
    const parsed = await parsedPromise;
    const userEmotion = "neutral";
    telemetry.endStep("intent_classifier_ms");
    telemetry.setIntent(parsed.kind, parsed.confidence, parsed.source);
    if (parsed.source !== "regex") telemetry.incrementLlmCalls();

    const saveState = async () => {
      if (!attachedSessionId) return;
      const resolvedEntities = telemetry.getTrace().entities;
      const currentState = (await getSessionState(attachedSessionId)) || {};
      let changed = false;

      const person = resolvedEntities?.person?.value && resolvedEntities.person.confidence && resolvedEntities.person.confidence >= 0.7
        ? resolvedEntities.person.value
        : parsed.personName;
      if (person) {
        currentState.lastPerson = person;
        const gender = await getGenderOfPerson(person);
        if (gender === "female") currentState.lastFemale = person;
        else currentState.lastMale = person;
        const resolvedPerson = resolvedEntities?.person;
        if (resolvedPerson && resolvedPerson.value === person) currentState.activePerson = {
          id: person, name: person, confidence: resolvedPerson.confidence!, source: "retrieval",
        };
        changed = true;
      }
      const project = resolvedEntities?.page?.value || parsed.docTitle;
      if (project) {
        currentState.lastProject = project;
        if (resolvedEntities?.page?.value) currentState.activeProject = {
          id: project, name: project, confidence: resolvedEntities.page.quality === "EXACT" ? 1 : 0.85, source: "retrieval",
        };
        changed = true;
      }

      if (changed) await updateSessionState(attachedSessionId, currentState);
    };

    const ctx: PipelineContext = {
      message: finalQuery,
      history,
      sessionId: attachedSessionId,
      lastProject: mergedEntities.lastProject,
      lastPerson: mergedEntities.lastPerson,
      lastMale: mergedEntities.lastMale,
      lastFemale: mergedEntities.lastFemale,
      sessionName: sessionDisplayName || undefined,
      reformulatedQuery: parsed.reformulatedQuery,
      telemetry,
    };

    // 6. Notion link
    const linkResponse = await tryNotionLinkAnswer(ctx, userEmotion, signal);
    if (linkResponse) {
      telemetry.setExecutionPath("Notion Link");
      response = linkResponse;
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
      if (attachedSessionId) await saveState().catch((err: any) => console.error("Error saving session state:", err));
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
    const ragResponse = await tryRagAnswer(parsed, ctx, {
      tStart,
      dNormalization: 0,
      dResolveQuery: 0,
      dReformulate: 0,
      dSqlAnswer: 0,
    }, signal, userEmotion);
    telemetry.endStep("rag_ms");
    telemetry.setExecutionPath("RAG Fallback");

    if (attachedSessionId) await saveState().catch((err: any) => console.error("Error saving session state:", err));
    response = ragResponse;
    return response;
  } finally {
    telemetry.finish();
  }
}
