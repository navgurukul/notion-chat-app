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
import { analyzeUserEmotion } from "@/lib/chat/emotion";
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
    const backtickMatches = [...content.matchAll(/`([^`]{2,60})`/g)];

    // e.g. "Title: Employee Onboarding Hub"
    const titlePrefixMatch = content.match(/^Title:\s*(.+)$/m);
    const titlePrefixCandidate = titlePrefixMatch?.[1] ?? null;

    const allCandidateSources: Array<[RegExpMatchArray | null, string]> = [];
    for (const m of boldMatches) allCandidateSources.push([m, m[1]]);
    for (const m of backtickMatches) allCandidateSources.push([m, m[1]]);
    if (titlePrefixCandidate) allCandidateSources.push([null, titlePrefixCandidate]);


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

    // Pattern 3: Title near project keywords
    for (const [, rawCandidate] of allCandidateSources) {
      const candidate = rawCandidate.trim();
      if (!candidate) continue;

      if (
        /^(status|owner|done|backlog|unknown|open|closed|in progress|testing|blocked|not started|sync changes)$/i.test(
          candidate,
        )
      )
        continue;
      if (candidate.split(/\s+/).length > 6) continue;
      if (candidate.length < 3) continue;

      const idx = content.indexOf(rawCandidate);
      const surrounding = content.slice(
        Math.max(0, (idx ?? 0) - 50),
        Math.min(content.length, (idx ?? 0) + 100),
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
    for (const [, rawCandidate] of allCandidateSources) {
      const candidate = rawCandidate.trim();
      if (!candidate) continue;

      const idx = content.indexOf(rawCandidate);
      const surrounding = content.slice(
        Math.max(0, (idx ?? 0) - 40),
        Math.min(content.length, (idx ?? 0) + 80),
      );

      if (/\b(owner|assignee|created by|assigned to|working on)\b/i.test(surrounding)) {
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
  const tStart = performance.now();

  const rawMessage = validateMessage(body.message);
  const history = sanitizeChatHistory(body.history);

  // 1. Analyze emotion!
  const emotionAnalysis = await analyzeUserEmotion(rawMessage, history);
  const userEmotion = emotionAnalysis.emotion;

  const sessionId = await attachSession(session, body.sessionId, rawMessage, userEmotion);

  const tNormStart = performance.now();
  const normalized = await normalizeLanguage(rawMessage);
  const { message, ambiguous } = await resolveFirstPerson(normalized, session);
  const dNormalization = performance.now() - tNormStart;

  if (ambiguous?.length) {
    return jsonAnswer(
      sessionId,
      `Multiple people named **${session.user?.name}** found in Notion:\n${ambiguous
        .map((n) => `- ${n}`)
        .join("\n")}\n\nWhich one did you mean?`,
    );
  }

  const ctx: PipelineContext = { message, history, sessionId };

  const linkResponse = await tryNotionLinkAnswer(ctx, userEmotion);
  if (linkResponse) return linkResponse;

  const tResolveStart = performance.now();
  const parsed = await resolveQuery(message);
  const dResolveQuery = performance.now() - tResolveStart;

  console.log("[query_debug]", {
    query: message,
    intent: detectIntent(message),
    year: extractYear(message),
    resolvedPerson: parsed.personName ?? null,
    resolvedProject: parsed.docTitle ?? null,
  });
  logParsedQuery(parsed);

  const tSqlStart = performance.now();
  const sqlResponse = await trySqlAnswer(parsed, ctx, userEmotion);
  const dSqlAnswer = performance.now() - tSqlStart;

  if (sqlResponse) {
    console.log(
      "[telemetry]",
      JSON.stringify({
        kind: parsed.kind,
        sqlHit: true,
        durations: {
          normalization: Math.round(dNormalization),
          intentClassification: Math.round(dResolveQuery),
          sqlAnswerAttempt: Math.round(dSqlAnswer),
          total: Math.round(performance.now() - tStart),
        },
        ts: Date.now(),
      }),
    );
    return sqlResponse;
  }

  if (isNotionLinkRequest(message)) {
    return jsonAnswer(
      sessionId,
      "Ask for a Notion link using the page title, e.g. **link for Employee Onboarding Hub**.",
      userEmotion,
    );
  }

  return tryRagAnswer(parsed, ctx, session, {
    tStart,
    dNormalization,
    dResolveQuery,
    dSqlAnswer,
  }, signal, userEmotion);
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
  userEmotion?: string,
): Promise<string | null> {
  if (typeof rawSessionId !== "string" || !rawSessionId.trim()) return null;

  const user = await getOrCreateUser(session);
  const ownsSession = await ensureSessionBelongsToUser(rawSessionId, user.id);
  if (!ownsSession) throw new ChatNotFoundError();

  await addChatMessage(rawSessionId, "user", message, userEmotion);
  return rawSessionId;
}

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat not found");
    this.name = "ChatNotFoundError";
  }
}

async function jsonAnswer(sessionId: string | null, answer: string, emotion?: string) {
  if (sessionId) await addChatMessage(sessionId, "bot", answer, emotion);
  return NextResponse.json({ answer, emotion });
}

async function tryNotionLinkAnswer(ctx: PipelineContext, emotion?: string) {
  if (!isNotionLinkRequest(ctx.message)) return null;

  const linkTitle = extractReferencedTitle(ctx.message, ctx.history);
  if (linkTitle) {
    const linkAnswer = await lookupPageLinkByTitle(linkTitle);
    if (linkAnswer) return jsonAnswer(ctx.sessionId, linkAnswer, emotion);
    return jsonAnswer(
      ctx.sessionId,
      `I couldn't find a synced Notion page titled **${linkTitle}**. Use **Sync changes**, or ask with the exact page title from Notion.`,
      emotion,
    );
  }

  if (/\b(it|this|that)\b/i.test(ctx.message)) {
    const unresolved =
      ctx.history.length > 0
        ? "I couldn't resolve which page you mean from chat history. Ask again with the full page title, e.g. link for **Structuring the Product Team**."
        : "I couldn't resolve which page you mean — include the page title, or ask about a page first so chat history has context.";
    return jsonAnswer(ctx.sessionId, unresolved, emotion);
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

async function trySqlAnswer(parsed: ParsedQuery, ctx: PipelineContext, emotion?: string) {
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
      return jsonAnswer(ctx.sessionId, directAnswer, emotion);
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
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(parsed), emotion);
  }

  if (directAnswer && !shouldFallbackToRag(parsed, directAnswer)) {
    logChatRoute("sql_hit", parsed, { answer_chars: directAnswer.length });
    return jsonAnswer(ctx.sessionId, directAnswer, emotion);
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
  timings: {
    tStart: number;
    dNormalization: number;
    dResolveQuery: number;
    dSqlAnswer: number;
  },
  signal?: AbortSignal,
  userEmotion?: string,
) {
  if (isMetadataOnlyKind(parsed.kind) && parsed.kind !== "team_activity") {
    logChatRoute("sql_miss_metadata", parsed, { blocked_rag: true });
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(parsed), userEmotion);
  }

  const titleBoost = resolveRagTitleBoost(parsed, ctx.message);
  const explicitPage = isExplicitPageQuestion(ctx.message, parsed.docTitle);

  let searchQuery: string;
  let method = "original";
  let dReformulate = 0;

  if (explicitPage && titleBoost) {
    searchQuery = titleBoost;
  } else {
    const tRefStart = performance.now();
    const reformulated = await reformulateSearchQuery(ctx.message, ctx.history);
    dReformulate = performance.now() - tRefStart;
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
    ctx.message.trim().split(/\s+/).length < 20;

  if (isVagueFollowUp) {
    if (lastProject && !titleBoost) {
      searchQuery = `${lastProject} ${searchQuery}`.trim();
      method = "history_entity";
    } else if (lastPerson && !parsed.personName) {
      searchQuery = `${lastPerson} ${searchQuery}`.trim();
      method = "history_entity";
    }
  }

  const tExpStart = performance.now();
  const searchQueries = SCOPED_RAG_KINDS.has(parsed.kind)
    ? [searchQuery]
    : (await expandSearchQueries(ctx.message, ctx.history, searchQuery))
        .queries;
  const dExpand = SCOPED_RAG_KINDS.has(parsed.kind) ? 0 : performance.now() - tExpStart;
  const multiQueryMethod = SCOPED_RAG_KINDS.has(parsed.kind)
    ? "primary_only"
    : "llm";

  logChatRoute("semantic_rag", parsed, {
    reformulation: method,
    multi_query: multiQueryMethod,
    search_queries: searchQueries,
    history_entity: isVagueFollowUp ? { lastProject, lastPerson } : undefined,
  });

  const tRetStart = performance.now();
  const {
    context: notionContext,
    confidence,
    chunkHits,
  } = await buildNotionContextWithConfidence(searchQueries, {
    titleBoost: titleBoost || undefined,
    year: parsed.year,
  });
  const dRetrieval = performance.now() - tRetStart;

  logRetrievalDiagnostics(parsed, searchQueries, confidence, chunkHits);

  if (!notionContext.trim()) {
    console.log(
      "[telemetry]",
      JSON.stringify({
        kind: parsed.kind,
        confidenceOk: false,
        reason: "empty_context",
        durations: {
          normalization: Math.round(timings.dNormalization),
          intentClassification: Math.round(timings.dResolveQuery),
          sqlAnswerAttempt: Math.round(timings.dSqlAnswer),
          queryReformulation: Math.round(dReformulate),
          queryExpansion: Math.round(dExpand),
          retrieval: Math.round(dRetrieval),
          total: Math.round(performance.now() - timings.tStart),
        },
        ts: Date.now(),
      }),
    );
    return jsonAnswer(
      ctx.sessionId,
      "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
      userEmotion,
    );
  }

  if (!confidence.ok) {
    console.log(
      "[telemetry]",
      JSON.stringify({
        kind: parsed.kind,
        confidenceOk: false,
        reason: confidence.reason,
        durations: {
          normalization: Math.round(timings.dNormalization),
          intentClassification: Math.round(timings.dResolveQuery),
          sqlAnswerAttempt: Math.round(timings.dSqlAnswer),
          queryReformulation: Math.round(dReformulate),
          queryExpansion: Math.round(dExpand),
          retrieval: Math.round(dRetrieval),
          total: Math.round(performance.now() - timings.tStart),
        },
        ts: Date.now(),
      }),
    );
    return jsonAnswer(ctx.sessionId, RETRIEVAL_REFUSAL_MESSAGE, userEmotion);
  }

  return streamGeminiAnswer(
    ctx.message,
    notionContext,
    ctx.history,
    ctx.sessionId,
    parsed.kind,
    signal,
    {
      tStart: timings.tStart,
      normalization: Math.round(timings.dNormalization),
      intentClassification: Math.round(timings.dResolveQuery),
      sqlAnswerAttempt: Math.round(timings.dSqlAnswer),
      queryReformulation: Math.round(dReformulate),
      queryExpansion: Math.round(dExpand),
      retrieval: Math.round(dRetrieval),
      expandedQueryCount: searchQueries.length,
      contextChars: notionContext.length,
      topScore: confidence.topScore,
      avgScore: confidence.avgScore,
      confidenceOk: confidence.ok,
      historyEntityUsed: isVagueFollowUp && (!!lastProject || !!lastPerson),
    },
    userEmotion,
  );
}



