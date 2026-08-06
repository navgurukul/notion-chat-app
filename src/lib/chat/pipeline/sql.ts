import { ParsedQuery } from "@/lib/query/types";
import { PipelineContext } from "./timing";
import { handleMetadataQuery } from "@/lib/sql/answers";
import { isSqlMissAnswer, isTeamActivityMetadataGap, shouldFallbackToRag } from "@/lib/chat/answer-quality";
import { isMetadataOnlyKind, metadataNotFoundAnswer } from "@/lib/chat/routing-policy";
import { logChatRoute } from "@/lib/chat/retrieval-diagnostics";
import { streamOpenAIAnswer } from "@/lib/chat/stream-response";
import { jsonAnswer } from "./router";

export function isSynthesisRequest(message: string): boolean {
  if (/\b(role|job|responsibilit|position|designation|title|summariz|summary|overview|analy[sz]|explain|opinion|think)\b/i.test(message)) {
    return true;
  }
  if (/\bwhat\s+(?:do|does|did)\s+.*\b(do|handle|manage)\b/i.test(message)) {
    return true;
  }
  return false;
}

import { lazyResolveSqlEntities } from "@/lib/query/entity-resolver";

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

  // Lazily resolve SQL entities
  const tEntStart = performance.now();
  if (ctx.telemetry) {
    ctx.telemetry.startStep("entity_resolve_ms");
  }
  const finalParsed = await lazyResolveSqlEntities(
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
  if (resolvedPerson) {
    if (resolvedPerson.ambiguous && resolvedPerson.candidates.length > 0) {
      const candidatesList = resolvedPerson.candidates.map((c: string) => `**${c}**`).join(" or ");
      const clarAnswer = `I found multiple possible matches for that person. Did you mean ${candidatesList}?`;
      return jsonAnswer(ctx.sessionId, clarAnswer, emotion, signal);
    }
    if (resolvedPerson.confidence < 0.7 && resolvedPerson.value) {
      const clarAnswer = `I found a partial match for "${parsed.personName || ctx.message}". Did you mean **${resolvedPerson.value}**?`;
      return jsonAnswer(ctx.sessionId, clarAnswer, emotion, signal);
    }
  }

  const metadataOnly = isMetadataOnlyKind(finalParsed.kind);
  const directAnswer = await handleMetadataQuery(finalParsed);

  if (signal?.aborted) return null;

  console.log("[trySqlAnswer] debug", {
    kind: finalParsed.kind,
    metadataOnly,
    directAnswerLength: directAnswer?.length ?? null,
    directAnswerPreview: directAnswer?.slice(0, 80) ?? null,
    isMiss: directAnswer ? isSqlMissAnswer(directAnswer) : "no answer",
  });

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
