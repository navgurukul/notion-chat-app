import type { Session } from "next-auth";
import type { ParsedQuery } from "@/lib/query/types";
import { PipelineContext, logChatRoute, logRetrievalDiagnostics } from "./telemetry";
import { isMetadataOnlyKind, metadataNotFoundAnswer } from "@/lib/chat/routing-policy";
import { reformulateSearchQuery, shouldReformulate, expandSearchQueries, reformulateAndExpand } from "@/lib/chat/query-tools";
import { buildNotionContextWithConfidence } from "@/lib/rag/build-context";
import { RETRIEVAL_REFUSAL_MESSAGE } from "@/lib/rag";
import { streamOpenAIAnswer } from "@/lib/chat/stream-response";
import { jsonAnswer } from "./smalltalk";

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
import type { ChatHistoryItem } from "@/lib/ai/openai";

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

  // Everything below can throw (LLM calls, DB calls, network hiccups). Wrapping it
  // means a failure degrades to a friendly message instead of an unhandled 500.
  try {
    // Lazily resolve RAG entities
    if (ctx.telemetry) {
      ctx.telemetry.startStep("entity_resolve_ms");
    }
    const finalParsed = await lazyResolveRagEntities(
      parsed,
      ctx.history,
      ctx.sessionName,
      { lastPerson: ctx.lastPerson, lastProject: ctx.lastProject, lastMale: ctx.lastMale, lastFemale: ctx.lastFemale }
    );
    if (ctx.telemetry) {
      ctx.telemetry.endStep("entity_resolve_ms");
      if (finalParsed.resolvedEntities?.person) {
        const p = finalParsed.resolvedEntities.person;
        ctx.telemetry.logEntity("person", p.value, p.quality, p.confidence, p.ambiguous, p.candidates);
      }
      if (finalParsed.resolvedEntities?.page) {
        const p = finalParsed.resolvedEntities.page;
        ctx.telemetry.logEntity("page", p.value, p.quality, undefined, undefined, undefined, p.url);
      }
    }

    if (isMetadataOnlyKind(finalParsed.kind) && finalParsed.kind !== "team_activity") {
      logChatRoute("sql_miss_metadata", finalParsed, { blocked_rag: true });
      return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(finalParsed), userEmotion, signal);
    }

    if (finalParsed.resolvedEntities?.person?.ambiguous && finalParsed.resolvedEntities.person.candidates.length > 0) {
      const candidatesList = finalParsed.resolvedEntities.person.candidates.map((c: string) => `**${c}**`).join(" or ");
      const clarAnswer = `I found multiple possible matches for that person. Did you mean ${candidatesList}?`;
      return jsonAnswer(ctx.sessionId, clarAnswer, userEmotion, signal);
    }

    const rawTitleBoost = resolveRagTitleBoost(finalParsed, ctx.message);
    const explicitPage = isExplicitPageQuestion(ctx.message, finalParsed.docTitle);
    const isExplicitTitleMatch = explicitPage || (rawTitleBoost ? ctx.message.toLowerCase().includes(rawTitleBoost.toLowerCase()) : false);
    const titleBoost = isExplicitTitleMatch ? rawTitleBoost : undefined;

    const hasExplicitTarget = Boolean(finalParsed.docTitle || finalParsed.personName);
    const shouldExpand =
      (BROAD_RAG_KINDS.has(finalParsed.kind) || !!ctx.isWrongAnswerRetry) && !hasExplicitTarget;

    let searchQuery: string;
    let searchQueries: string[];
    let method = "original";
    let multiQueryMethod = "primary_only";

    if (explicitPage && titleBoost) {
      searchQuery = titleBoost;
      searchQueries = [titleBoost];
    } else {
      if (ctx.telemetry) {
        ctx.telemetry.startStep("reformulation_ms");
        ctx.telemetry.incrementLlmCalls();
      }
      const unified = await reformulateAndExpand(
        ctx.message,
        ctx.history,
        finalParsed.kind,
        !shouldExpand
      );
      if (ctx.telemetry) {
        ctx.telemetry.endStep("reformulation_ms");
        ctx.telemetry.setReformulatedQuery(unified.searchQuery);
      }
      searchQuery = unified.searchQuery;
      searchQueries = unified.queries;
      method = unified.reformulationMethod;
      multiQueryMethod = unified.multiQueryMethod;
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

    const hints: string[] = [];
    if (titleBoost && isExplicitTitleMatch) hints.push(`Project/Topic: ${titleBoost}`);
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

    if (ctx.telemetry) {
      ctx.telemetry.startStep("retrieval_ms");
    }
    let {
      context: notionContext,
      confidence,
      chunkHits,
    } = await buildNotionContextWithConfidence(searchQueries, {
      titleBoost: titleBoost || undefined,
      year: finalParsed.year,
      loosenThreshold: !!ctx.isWrongAnswerRetry,
    });

    if (process.env.NODE_ENV !== "production" || process.env.DEBUG_RETRIEVAL === "true") {
      console.log(`[retrieval-trace] Message: "${ctx.message}" | SearchQuery: "${searchQuery}" | TitleBoost: "${titleBoost ?? 'none'}" | ConfidenceOK: ${confidence.ok} | TopHit: "${chunkHits[0]?.title ?? 'none'}" (score: ${chunkHits[0]?.final_score ?? 0})`);
    }

    if (!confidence.ok) {
      if (process.env.NODE_ENV !== "production" || process.env.DEBUG_RETRIEVAL === "true") {
        console.log("[retrieval] confidence low, attempting retry...", { confidence });
      }

      const broaderQueries = searchQueries.map(q => {
        let cleaned = q.replace(/\b20\d{2}\b/g, "").trim();
        cleaned = cleaned.replace(/(Person:|Project\/Topic:|Year:)\s*[^\n]+/gi, "").trim();
        cleaned = cleaned.split("\n").map(l => l.trim()).filter(Boolean).join(" ");
        return cleaned;
      }).filter(Boolean);

      // Only append titleBoost to retry if explicit or vague follow-up
      if (isExplicitTitleMatch && titleBoost && !broaderQueries.includes(titleBoost)) {
        broaderQueries.push(titleBoost);
      }

      if (broaderQueries.length > 0) {
        if (process.env.NODE_ENV !== "production" || process.env.DEBUG_RETRIEVAL === "true") {
          console.log("[retrieval] retrying with broader queries:", broaderQueries);
        }
        const retryResult = await buildNotionContextWithConfidence(broaderQueries, {
          titleBoost: titleBoost || undefined,
          loosenThreshold: !!ctx.isWrongAnswerRetry,
        });

        // Keep the retry result if:
        //  - it clears the confidence bar outright, OR
        //  - the original attempt had nothing at all, OR
        //  - the retry scored strictly better than the original, even if still
        //    below the "ok" threshold (previously this case was discarded entirely,
        //    silently losing a better-but-imperfect match).
        const retryIsBetter =
          retryResult.confidence.ok ||
          (retryResult.context.trim() && !notionContext.trim()) ||
          (retryResult.context.trim() &&
            retryResult.confidence.topScore > confidence.topScore);

        if (retryIsBetter) {
          if (process.env.NODE_ENV !== "production" || process.env.DEBUG_RETRIEVAL === "true") {
            console.log("[retrieval] retry successful!", { newConfidence: retryResult.confidence });
          }
          notionContext = retryResult.context;
          confidence = retryResult.confidence;
          chunkHits = retryResult.chunkHits;
        }
      }
    }
    if (ctx.telemetry) {
      ctx.telemetry.endStep("retrieval_ms");
      const vectorHits = chunkHits.filter(h => h.sem_score > 0).length;
      const ftsHits = chunkHits.filter(h => h.kw_score > 0).length;
      ctx.telemetry.logRetrieval(vectorHits, ftsHits, chunkHits.length, chunkHits.length, chunkHits.length);
    }

    logRetrievalDiagnostics(finalParsed, searchQueries, confidence, chunkHits);

    if (!notionContext.trim()) {
      return jsonAnswer(
        ctx.sessionId,
        "I couldn't find matching pages in the synced Notion database. Try **Sync changes** in the sidebar, or rephrase with a project/person/page name from Notion.",
        userEmotion,
        signal,
      );
    }

    if (!confidence.ok) {
      return jsonAnswer(ctx.sessionId, RETRIEVAL_REFUSAL_MESSAGE, userEmotion, signal);
    }

    if (ctx.telemetry) {
      ctx.telemetry.incrementLlmCalls();
    }
    return streamOpenAIAnswer(
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
        queryReformulation: 0,
        queryExpansion: 0,
        retrieval: 0,
        expandedQueryCount: searchQueries.length,
        contextChars: notionContext.length,
        topScore: confidence.topScore,
        avgScore: confidence.avgScore,
        confidenceOk: confidence.ok,
        historyEntityUsed: isVagueFollowUp && (!!lastProject || !!lastPerson),
      },
      userEmotion,
    );
  } catch (error) {
    console.error("[tryRagAnswer] unhandled retrieval/generation error:", error);
    return jsonAnswer(
      ctx.sessionId,
      "Something went wrong while looking that up. Try rephrasing, or try again in a moment.",
      userEmotion,
      signal,
    );
  }
}
