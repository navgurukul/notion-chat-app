import type { Session } from "next-auth";
import type { ParsedQuery } from "@/lib/query/types";
import { PipelineContext } from "./timing";
import { isMetadataOnlyKind, metadataNotFoundAnswer } from "@/lib/chat/routing-policy";
import { reformulateSearchQuery, shouldReformulate } from "@/lib/chat/query-reformulation";
import { expandSearchQueries } from "@/lib/chat/multi-query";
import { logChatRoute, logRetrievalDiagnostics } from "@/lib/chat/retrieval-diagnostics";
import { buildNotionContextWithConfidence } from "@/lib/rag/build-context";
import { RETRIEVAL_REFUSAL_MESSAGE } from "@/lib/rag/retrieval-confidence";
import { streamGeminiAnswer } from "@/lib/chat/stream-response";
import { jsonAnswer } from "./router";

const BROAD_RAG_KINDS = new Set<ParsedQuery["kind"]>([
  "semantic",
  "page_about",
  "project_summary",
  "risks_for",
  "topic_list",
]);

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

import { lazyResolveRagEntities } from "@/lib/query/entity-resolver";
import { ChatHistoryItem } from "@/lib/ai/gemini";

export async function tryRagAnswer(
  parsed: ParsedQuery,
  ctx: PipelineContext,
  session: Session,
  timings: {
    tStart: number;
    dNormalization: number;
    dResolveQuery: number;
    dReformulate: number;
    dSqlAnswer: number;
  },
  signal?: AbortSignal,
  userEmotion?: string,
) {
  if (signal?.aborted) {
    return new Response(null, { status: 499 });
  }

  // Lazily resolve RAG entities
  const tEntStart = performance.now();
  const finalParsed = await lazyResolveRagEntities(
    parsed,
    ctx.history,
    { lastPerson: ctx.lastPerson, lastProject: ctx.lastProject }
  );
  const dEntityResolve = performance.now() - tEntStart;
  if (ctx.trace && !ctx.trace.durations.entity_resolve_ms) {
    ctx.trace.durations.entity_resolve_ms = Math.round(dEntityResolve);
    ctx.trace.entities = finalParsed.resolvedEntities;
    ctx.trace.pronounResolvedQuery = finalParsed.raw;
  }

  if (isMetadataOnlyKind(finalParsed.kind) && finalParsed.kind !== "team_activity") {
    logChatRoute("sql_miss_metadata", finalParsed, { blocked_rag: true });
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(finalParsed), userEmotion, signal);
  }

  const titleBoost = resolveRagTitleBoost(finalParsed, ctx.message);
  const explicitPage = isExplicitPageQuestion(ctx.message, finalParsed.docTitle);

  let searchQuery: string;
  let method = "original";
  let dReformulate = timings.dReformulate;

  if (explicitPage && titleBoost) {
    searchQuery = titleBoost;
  } else if (ctx.reformulatedQuery) {
    searchQuery = ctx.reformulatedQuery;
    method = "reformulated";
  } else if (shouldReformulate(ctx.message, ctx.history)) {
    const tRefStart = performance.now();
    const reformulated = await reformulateSearchQuery(ctx.message, ctx.history, finalParsed.kind);
    dReformulate = performance.now() - tRefStart;
    searchQuery = reformulated.searchQuery;
    method = reformulated.method;
  } else {
    searchQuery = ctx.message;
    method = "original";
  }

  const lastProject = ctx.lastProject;
  const lastPerson = ctx.lastPerson;

  const isVagueFollowUp =
    !finalParsed.docTitle &&
    !finalParsed.personName &&
    /\b(this|that|it|more|explain|project|core|detail|in depth|elaborate|tell me more|what about|only for|for \d{4}|in \d{4}|more information|more about|about it)\b/i.test(
      ctx.message,
    ) &&
    ctx.message.trim().split(/\s+/).length < 20;

  if (isVagueFollowUp) {
    if (lastProject && !titleBoost) {
      searchQuery = `${lastProject} ${searchQuery}`.trim();
      method = "history_entity";
    } else if (lastPerson && !finalParsed.personName) {
      searchQuery = `${lastPerson} ${searchQuery}`.trim();
      method = "history_entity";
    }
  }

  const shouldExpand = BROAD_RAG_KINDS.has(finalParsed.kind);
  const tExpStart = performance.now();
  let searchQueries = shouldExpand
    ? (await expandSearchQueries(ctx.message, ctx.history, searchQuery)).queries
    : [searchQuery];
  const dExpand = shouldExpand ? performance.now() - tExpStart : 0;
  const multiQueryMethod = shouldExpand ? "llm" : "primary_only";

  const hints: string[] = [];
  if (titleBoost && !explicitPage) hints.push(`Project/Topic: ${titleBoost}`);
  if (finalParsed.personName?.trim()) hints.push(`Person: ${finalParsed.personName.trim()}`);
  if (finalParsed.year) hints.push(`Year: ${finalParsed.year}`);
  if (hints.length && !explicitPage) {
    const hintBlock = hints.join("\n");
    searchQueries = searchQueries.map(q => `${q}\n${hintBlock}`);
  }

  logChatRoute("semantic_rag", finalParsed, {
    reformulation: method,
    multi_query: multiQueryMethod,
    search_queries: searchQueries,
    history_entity: isVagueFollowUp ? { lastProject, lastPerson } : undefined,
  });

  const tRetStart = performance.now();
  let {
    context: notionContext,
    confidence,
    chunkHits,
  } = await buildNotionContextWithConfidence(searchQueries, {
    titleBoost: titleBoost || undefined,
    year: finalParsed.year,
  });

  if (!confidence.ok) {
    console.log("[retrieval] confidence low, attempting retry...", { confidence });

    const broaderQueries = searchQueries.map(q => {
      let cleaned = q.replace(/\b20\d{2}\b/g, "").trim();
      cleaned = cleaned.replace(/(Person:|Project\/Topic:|Year:)\s*[^\n]+/gi, "").trim();
      cleaned = cleaned.split("\n").map(l => l.trim()).filter(Boolean).join(" ");
      return cleaned;
    }).filter(Boolean);

    if (titleBoost && !broaderQueries.includes(titleBoost)) {
      broaderQueries.push(titleBoost);
    }

    if (broaderQueries.length > 0) {
      console.log("[retrieval] retrying with broader queries:", broaderQueries);
      const retryResult = await buildNotionContextWithConfidence(broaderQueries, {
        titleBoost: titleBoost || undefined,
      });

      if (retryResult.confidence.ok || (retryResult.context.trim() && !notionContext.trim())) {
        console.log("[retrieval] retry successful!", { newConfidence: retryResult.confidence });
        notionContext = retryResult.context;
        confidence = retryResult.confidence;
        chunkHits = retryResult.chunkHits;
      }
    }
  }
  const dRetrieval = performance.now() - tRetStart;

  logRetrievalDiagnostics(finalParsed, searchQueries, confidence, chunkHits);

  if (!notionContext.trim()) {
    console.log(
      "[telemetry]",
      JSON.stringify({
        kind: finalParsed.kind,
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
      signal,
    );
  }

  if (!confidence.ok) {
    console.log(
      "[telemetry]",
      JSON.stringify({
        kind: finalParsed.kind,
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
    return jsonAnswer(ctx.sessionId, RETRIEVAL_REFUSAL_MESSAGE, userEmotion, signal);
  }

  return streamGeminiAnswer(
    ctx.message,
    notionContext,
    ctx.history,
    ctx.sessionId,
    finalParsed.kind,
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
