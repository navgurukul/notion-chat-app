export type ChunkRetrievalHit = {
  chunk_id: string;
  page_id: string;
  title: string | null;
  final_score: number;
  sem_score: number;
  kw_score: number;
};

export type RetrievalConfidenceResult = {
  ok: boolean;
  reason?: string;
  topScore: number;
  avgScore: number;
  chunkCount: number;
  prefetchChars: number;
};

function readThreshold(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getMinTopScore() {
  return readThreshold("RETRIEVAL_MIN_TOP_SCORE", 0.1);
}

function getMinAvgScore() {
  return readThreshold("RETRIEVAL_MIN_AVG_SCORE", 0.06);
}

function getStrongTopScore() {
  return readThreshold("RETRIEVAL_STRONG_TOP_SCORE", 0.22);
}

function getMinChunkCount() {
  return Math.max(1, Math.floor(readThreshold("RETRIEVAL_MIN_CHUNKS", 2)));
}

/**
 * Evidence gate before LLM generation.
 * Prefetch-only context can pass when chunk scores are weak but DB pages matched.
 */
export function assessRetrievalConfidence(
  hits: ChunkRetrievalHit[],
  prefetchChars: number,
  loosen?: boolean,
): RetrievalConfidenceResult {
  const chunkCount = hits.length;
  const topScore = hits[0]?.final_score ?? 0;
  const avgScore =
    chunkCount > 0
      ? hits.reduce((sum, hit) => sum + hit.final_score, 0) / chunkCount
      : 0;
  const prefetchCharsSafe = Math.max(0, prefetchChars);

  const minTop = loosen ? getMinTopScore() / 2 : getMinTopScore();
  const minAvg = loosen ? getMinAvgScore() / 2 : getMinAvgScore();
  const strongTop = loosen ? getStrongTopScore() / 2 : getStrongTopScore();
  const minChunks = loosen ? Math.max(1, Math.floor(getMinChunkCount() / 2)) : getMinChunkCount();
  const minPrefetch = loosen ? 200 : 400;

  if (chunkCount === 0) {
    if (prefetchCharsSafe >= minPrefetch) {
      return { ok: true, topScore: 0, avgScore: 0, chunkCount: 0, prefetchChars: prefetchCharsSafe };
    }
    return {
      ok: false,
      reason: "no_chunks_or_prefetch",
      topScore: 0,
      avgScore: 0,
      chunkCount: 0,
      prefetchChars: prefetchCharsSafe,
    };
  }

  if (topScore >= strongTop) {
    return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe };
  }

  if (topScore >= minTop && chunkCount >= minChunks && avgScore >= minAvg) {
    return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe };
  }

  if (topScore >= minTop && prefetchCharsSafe >= minPrefetch) {
    return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe };
  }

  return {
    ok: false,
    reason: "low_retrieval_scores",
    topScore,
    avgScore,
    chunkCount,
    prefetchChars: prefetchCharsSafe,
  };
}

export const RETRIEVAL_REFUSAL_MESSAGE =
  "I couldn’t confidently answer from the currently synced Notion data. I found some related context but it may be incomplete—try **Sync changes**, include the exact project/person/page title from Notion, or rephrase with more specific keywords.";

