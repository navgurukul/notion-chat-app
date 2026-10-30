import { ParsedQuery } from "@/lib/query/types";
import { PipelineContext } from "./telemetry";
import { handleMetadataQuery } from "@/lib/sql/answers";
import {
  isMetadataOnlyKind,
  isSqlMissAnswer,
  isTeamActivityMetadataGap,
  metadataNotFoundAnswer,
  shouldFallbackToRag,
} from "@/lib/chat/routing-policy";
import { logChatRoute } from "./telemetry";
import { streamOpenAIAnswer } from "@/lib/chat/stream-response";
import { jsonAnswer } from "./smalltalk";
import { buildClarificationAnswer } from "@/lib/chat/clarification";
import { lazyResolveSqlEntities } from "@/lib/query/entity-resolver";

export function isSynthesisRequest(message: string): boolean {
  if (/\b(role|job|responsibilit|position|designation|title|summariz|summary|overview|analy[sz]|explain|opinion|think)\b/i.test(message)) {
    return true;
  }
  if (/\bwhat\s+(?:do|does|did)\s+.*\b(do|handle|manage)\b/i.test(message)) {
    return true;
  }
  return false;
}

export async function trySqlAnswer(
  parsed: ParsedQuery,
  ctx: PipelineContext,
  emotion?: string,
  signal?: AbortSignal,
  timings?: {
    tStart: number;
    dNormalization: number;
    dResolveQuery: number;
  },
) {
  if (parsed.kind === "semantic" || parsed.kind === "smalltalk") return null;

  // Lazily resolve SQL entities if not pre-resolved
  if (ctx.telemetry) {
    ctx.telemetry.startStep("entity_resolve_ms");
  }
  const finalParsed = parsed.resolvedEntities
    ? parsed
    : await lazyResolveSqlEntities(
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

  const resolvedPerson = finalParsed.resolvedEntities?.person;
  const clarAnswer = buildClarificationAnswer(resolvedPerson, parsed.personName || ctx.message);
  if (clarAnswer) {
    return jsonAnswer(ctx.sessionId, clarAnswer, emotion, signal);
  }

  const metadataOnly = isMetadataOnlyKind(finalParsed.kind);
  const directAnswer = await handleMetadataQuery(finalParsed);

  if (signal?.aborted) return null;

  if (process.env.NODE_ENV !== "production" || process.env.CHAT_DEBUG === "true") {
    console.log("[trySqlAnswer] debug", {
      kind: finalParsed.kind,
      metadataOnly,
      directAnswerLength: directAnswer?.length ?? null,
      directAnswerPreview: directAnswer?.slice(0, 80) ?? null,
      isMiss: directAnswer ? isSqlMissAnswer(directAnswer) : "no answer",
    });
  }

  if (directAnswer?.trim() && !isSqlMissAnswer(directAnswer)) {
    const isSynthesis = isSynthesisRequest(ctx.message);
    if (isSynthesis) {
      logChatRoute("sql_synthesis_stream", finalParsed, { answer_chars: directAnswer.length });
      return streamOpenAIAnswer(
        ctx.message,
        directAnswer,
        ctx.history,
        ctx.sessionId,
        finalParsed.kind,
        signal,
        timings
          ? {
              tStart: timings.tStart,
              normalization: Math.round(timings.dNormalization),
              intentClassification: Math.round(timings.dResolveQuery),
              sqlAnswerAttempt: Math.round(performance.now() - timings.tStart),
              queryReformulation: 0,
              queryExpansion: 0,
              retrieval: 0,
              expandedQueryCount: 1,
              contextChars: directAnswer.length,
              topScore: 1.0,
              avgScore: 1.0,
              confidenceOk: true,
              historyEntityUsed: false,
            }
          : undefined,
        emotion,
      );
    }
  }

  if (metadataOnly) {
    if (directAnswer?.trim() && !isSqlMissAnswer(directAnswer)) {
      logChatRoute("sql_hit", finalParsed, { answer_chars: directAnswer.length });
      return jsonAnswer(ctx.sessionId, directAnswer, emotion, signal);
    }
    if (
      finalParsed.kind === "team_activity" &&
      isTeamActivityMetadataGap(directAnswer)
    ) {
      logChatRoute("sql_weak_rag", finalParsed, {
        team_activity_metadata_gap: true,
      });
      return null;
    }
    logChatRoute("sql_miss_metadata", finalParsed, {
      had_sql: Boolean(directAnswer),
    });
    return jsonAnswer(ctx.sessionId, metadataNotFoundAnswer(finalParsed), emotion, signal);
  }

  if (directAnswer && !shouldFallbackToRag(finalParsed, directAnswer)) {
    logChatRoute("sql_hit", finalParsed, { answer_chars: directAnswer.length });
    return jsonAnswer(ctx.sessionId, directAnswer, emotion, signal);
  }

  if (directAnswer) {
    logChatRoute("sql_weak_rag", finalParsed, { answer_chars: directAnswer.length });
  } else {
    logChatRoute("sql_weak_rag", finalParsed, { sql_empty: true });
  }

  return null;
}
