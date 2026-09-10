import type { Session } from "next-auth";
import type { ParsedQuery } from "@/lib/query/types";
import { PipelineContext, logChatRoute, logRetrievalDiagnostics } from "./telemetry";
import { isMetadataOnlyKind, metadataNotFoundAnswer, shouldExpandRagQuery } from "@/lib/chat/routing-policy";
import { reformulateAndExpand } from "@/lib/chat/query-tools";
import { buildNotionContextWithConfidence } from "@/lib/rag/build-context";
import { RETRIEVAL_REFUSAL_MESSAGE } from "@/lib/rag";
import { streamOpenAIAnswer } from "@/lib/chat/stream-response";
import { jsonAnswer } from "./smalltalk";
import { buildClarificationAnswer } from "@/lib/chat/clarification";
import { lazyResolveRagEntities } from "@/lib/query/entity-resolver";

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

type RagSearchPlan = {
  searchQuery: string;
  searchQueries: string[];
  method: string;
  multiQueryMethod: string;
  titleBoost?: string;
  explicitPage: boolean;
  shouldExpand: boolean;
  isVagueFollowUp: boolean;
  lastProject?: string;
  lastPerson?: string;
  usePreReformulated: boolean;
};

function buildRagSearchPlan(parsed: ParsedQuery, ctx: PipelineContext): RagSearchPlan {
  const rawTitleBoost = resolveRagTitleBoost(parsed, ctx.message);
  const explicitPage = isExplicitPageQuestion(ctx.message, parsed.docTitle);
  const isExplicitTitleMatch = explicitPage || (rawTitleBoost ? ctx.message.toLowerCase().includes(rawTitleBoost.toLowerCase()) : false);
  const titleBoost = isExplicitTitleMatch ? rawTitleBoost : undefined;

  const hasExplicitTarget = Boolean(parsed.docTitle || parsed.personName);
  const shouldExpand = (shouldExpandRagQuery(parsed.kind) || !!ctx.isWrongAnswerRetry) && !hasExplicitTarget;

  let searchQuery = ctx.message;
  let searchQueries = [ctx.message];
  let method = "original";
  const multiQueryMethod = "primary_only";
  let usePreReformulated = false;

  if (explicitPage && titleBoost) {
    searchQuery = titleBoost;
    searchQueries = [titleBoost];
  } else if (ctx.reformulatedQuery && !shouldExpand) {
    searchQuery = ctx.reformulatedQuery;
    searchQueries = [ctx.reformulatedQuery];
    method = "pre_reformulated";
    usePreReformulated = true;
  }

  const lastProject = ctx.lastProject;
  const lastPerson = ctx.lastPerson;

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
      searchQueries = [searchQuery];
      method = "history_entity";
    } else if (lastPerson && !parsed.personName) {
      searchQuery = `${lastPerson} ${searchQuery}`.trim();
      searchQueries = [searchQuery];
      method = "history_entity";
    }
  }

  return {
    searchQuery,
    searchQueries,
    method,
    multiQueryMethod,
    titleBoost,
    explicitPage,
    shouldExpand,
    isVagueFollowUp,
    lastProject,
    lastPerson,
    usePreReformulated,
  };
}

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

  try {
    // Lazily resolve RAG entities if not pre-resolved
    if (ctx.telemetry) {
      ctx.telemetry.startStep("entity_resolve_ms");
    }
    const finalParsed = parsed.resolvedEntities
      ? parsed
      : await lazyResolveRagEntities(
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

    const clarAnswer = buildClarificationAnswer(
      finalParsed.resolvedEntities?.person,
      finalParsed.personName || ctx.message
    );
    if (clarAnswer) {
      return jsonAnswer(ctx.sessionId, clarAnswer, userEmotion, signal);
    }

    const searchPlan = buildRagSearchPlan(finalParsed, ctx);
    const { titleBoost, explicitPage, shouldExpand, isVagueFollowUp, lastProject, lastPerson, usePreReformulated } = searchPlan;
    let { searchQuery, searchQueries, method, multiQueryMethod } = searchPlan;

    if (!explicitPage && !usePreReformulated) {
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

    const hints: string[] = [];
    if (titleBoost && explicitPage) hints.push(`Project/Topic: ${titleBoost}`);
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

      if (explicitPage && titleBoost && !broaderQueries.includes(titleBoost)) {
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

        const targetEntity = (titleBoost || finalParsed.personName)?.toLowerCase();
        const topHitTitle = retryResult.chunkHits[0]?.title?.toLowerCase();
        const hasEntityAlignment = !targetEntity || !topHitTitle || topHitTitle.includes(targetEntity);

        const retryIsBetter =
          (retryResult.confidence.ok && hasEntityAlignment) ||
          (retryResult.context.trim() && !notionContext.trim()) ||
          (retryResult.context.trim() &&
            retryResult.confidence.topScore > confidence.topScore &&
            hasEntityAlignment);

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
