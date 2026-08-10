import type { ParsedQuery } from "@/lib/query/types";
import type { ChunkRetrievalHit, RetrievalConfidenceResult } from "@/lib/rag";

export type RouteDecision = "sql_hit" | "sql_miss_metadata" | "sql_weak_rag" | "semantic_rag" | "link" | "sql_synthesis_stream";

export function logChatRoute(decision: RouteDecision, parsed: ParsedQuery, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production" && process.env.CHAT_DEBUG !== "true") return;

  console.log("[chat] route", {
    decision,
    kind: parsed.kind,
    confidence: parsed.confidence,
    source: parsed.source,
    personName: parsed.personName,
    docTitle: parsed.docTitle,
    ...extra,
  });
}

export function logRetrievalDiagnostics(
  parsed: ParsedQuery,
  searchQueries: string[],
  confidence: RetrievalConfidenceResult,
  hits: ChunkRetrievalHit[],
) {
  if (process.env.NODE_ENV === "production" && process.env.CHAT_DEBUG !== "true") return;

  console.log("[chat] retrieval", {
    kind: parsed.kind,
    search_queries: searchQueries,
    confidence_ok: confidence.ok,
    confidence_reason: confidence.reason,
    top_score: Number(confidence.topScore.toFixed(4)),
    avg_score: Number(confidence.avgScore.toFixed(4)),
    chunk_count: confidence.chunkCount,
    prefetch_chars: confidence.prefetchChars,
    top_chunks: hits.slice(0, 5).map((hit) => ({
      title: hit.title,
      final: Number(hit.final_score.toFixed(4)),
      sem: Number(hit.sem_score.toFixed(4)),
      kw: Number(hit.kw_score.toFixed(4)),
    })),
  });
}
