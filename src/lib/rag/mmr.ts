/**
 * Maximum Marginal Relevance (MMR) — pick relevant but diverse chunks.
 * Reduces redundant near-duplicate chunks in RAG context.
 */
import { keepLettersNumbersAndSpaces, splitWords, toLower } from "@/lib/shared/text-utils";

export type MMRCandidate = {
  id: string;
  relevance: number;
  embedding?: number[] | null;
  text?: string | null;
  page_id?: string;
};

function readLambda() {
  const parsed = Number(process.env.MMR_LAMBDA);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  return 0.85;
}

function readMaxPerPage() {
  const parsed = Number(process.env.RETRIEVAL_MAX_CHUNKS_PER_PAGE);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 2;
}

export function isMmrEnabled() {
  return process.env.MMR_ENABLED !== "false";
}

export function parsePgVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (value as number[])
      : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (parsed as number[])
      : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenSet(text: string) {
  return new Set(
    splitWords(keepLettersNumbersAndSpaces(toLower(text))).filter((word) => word.length >= 3),
  );
}

function jaccardSimilarity(a: string, b: string) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function pairSimilarity(a: MMRCandidate, b: MMRCandidate) {
  if (a.embedding?.length && b.embedding?.length) {
    return cosineSimilarity(a.embedding, b.embedding);
  }

  const textA = a.text?.trim() ?? "";
  const textB = b.text?.trim() ?? "";
  if (!textA || !textB) return 0;

  return jaccardSimilarity(textA, textB);
}

/**
 * MMR: score = λ * relevance − (1−λ) * max_similarity_to_already_selected
 */
export function selectWithMMR<T extends MMRCandidate>(
  candidates: T[],
  topK: number,
): T[] {
  if (!candidates.length || topK <= 0) return [];

  const lambda = readLambda();
  const maxPerPage = readMaxPerPage();
  const maxRelevance = Math.max(...candidates.map((c) => c.relevance), 1e-6);

  const pool = [...candidates].sort((a, b) => b.relevance - a.relevance);
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const pageCounts = new Map<string, number>();

  while (selected.length < topK) {
    let best: T | null = null;
    let bestScore = -Infinity;

    for (const candidate of pool) {
      if (selectedIds.has(candidate.id)) continue;

      const pageKey = candidate.page_id ?? candidate.id;
      if ((pageCounts.get(pageKey) ?? 0) >= maxPerPage) continue;

      const relevanceNorm = candidate.relevance / maxRelevance;
      let maxSim = 0;

      for (const picked of selected) {
        maxSim = Math.max(maxSim, pairSimilarity(candidate, picked));
      }

      const mmrScore = lambda * relevanceNorm - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        best = candidate;
      }
    }

    if (!best) break;

    selected.push(best);
    selectedIds.add(best.id);
    const pageKey = best.page_id ?? best.id;
    pageCounts.set(pageKey, (pageCounts.get(pageKey) ?? 0) + 1);
  }

  return selected;
}

/** Drop near-duplicate chunks by text overlap (fast pre-filter before MMR). */
export function dedupeByTextOverlap<T extends MMRCandidate>(
  candidates: T[],
  threshold = 0.85,
): T[] {
  const kept: T[] = [];

  for (const candidate of candidates) {
    const text = candidate.text?.trim() ?? "";
    if (!text) {
      kept.push(candidate);
      continue;
    }

    const isDuplicate = kept.some((existing) => {
      const other = existing.text?.trim() ?? "";
      if (!other) return false;
      return jaccardSimilarity(text, other) >= threshold;
    });

    if (!isDuplicate) kept.push(candidate);
  }

  return kept;
}
