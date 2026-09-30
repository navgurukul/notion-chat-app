/**
 * Consolidated RAG helpers and exports.
 * This file merges small helper modules (question-terms, mmr, retrieval-confidence,
 * search-titles) to reduce file count while keeping the existing large modules
 * (build-context, hybrid-search, semantic-search) intact.
 */
import { splitWords, keepLettersNumbersAndSpaces, toLower } from "@/lib/shared/text-utils";
import { extractCrossDocSummaryTopic } from "@/lib/query/normalize";
import { containsPhrase, extractAfterPhrase } from "@/lib/shared/text-utils";

// ---- question-terms (inlined) ----
const QT_STOP_WORDS = new Set([
  "a","an","and","are","about","any","can","could","current","do","does","for","from","give","how","in","is","it","me","of","on","or","please","progress","show","status","summarize","summary","tell","the","this","to","what","when","where","which","who","why","you","your",
]);

function qt_normalizeQuestionWords(question: string) {
  const cleaned = question
    .split("“").join('"')
    .split("”").join('"')
    .split("‘").join("'")
    .split("’").join("'");
  return splitWords(keepLettersNumbersAndSpaces(cleaned));
}

function qt_extractTopicPhrases(question: string) {
  const phrases: string[] = [];
  const progress = extractAfterPhrase(question, ["progress on", "status on"], { maxLength: 40, skipLeadingWords: ["the", "a", "project"] });
  if (progress) phrases.push(progress);

  const about = extractAfterPhrase(question, ["tell me about", "about", "regarding"], { maxLength: 60, skipLeadingWords: ["the", "a"] });
  if (about) phrases.push(about);

  const crossDocTopic = extractCrossDocSummaryTopic(question);
  if (crossDocTopic) phrases.unshift(crossDocTopic);

  const lower = toLower(question);
  if (containsPhrase(lower, " module")) {
    const moduleIndex = lower.lastIndexOf(" module");
    const beforeModule = question.slice(0, moduleIndex).trim();
    const words = splitWords(beforeModule);
    if (words.length >= 1) {
      const nameWords = words.slice(-6);
      let phrase = nameWords.join(" ").trim();
      if (phrase.toLowerCase().startsWith("this ") || phrase.toLowerCase().startsWith("that ")) {
        phrase = splitWords(phrase).slice(1).join(" ");
      }
      if (phrase.length >= 3) {
        phrases.push(phrase);
        phrases.push(`${phrase} module`);
      }
    }
  }

  const whyHowTopic = qt_extractWhyOrHowTopic(question);
  if (whyHowTopic) phrases.push(whyHowTopic);

  return phrases;
}

function qt_extractWhyOrHowTopic(question: string) {
  const lower = toLower(question);
  if (!lower.includes("why") && !lower.includes("how")) return null;
  const triggers = [" for ", " in ", " on "];
  for (const trigger of triggers) {
    const index = lower.indexOf(trigger);
    if (index === -1) continue;
    const after = question.slice(index + trigger.length).trim();
    const words = splitWords(after);
    if (words.length === 0) continue;
    return words.slice(0, 8).join(" ").trim();
  }
  return null;
}

export function extractQuestionTerms(question: string) {
  const tokens = qt_normalizeQuestionWords(question).filter((word) => word.length >= 2 && !QT_STOP_WORDS.has(toLower(word)));
  const phrases = qt_extractTopicPhrases(question);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of [...phrases, ...tokens]) {
    const key = toLower(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, 8);
}

// ---- mmr (inlined) ----
export type MMRCandidate = { id: string; relevance: number; embedding?: number[] | null; text?: string | null; page_id?: string };

function mmr_readLambda() {
  const parsed = Number(process.env.MMR_LAMBDA);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  return 0.85;
}

function mmr_readMaxPerPage() {
  const parsed = Number(process.env.RETRIEVAL_MAX_CHUNKS_PER_PAGE);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 2;
}

export function isMmrEnabled() { return process.env.MMR_ENABLED !== "false"; }

export function parsePgVector(value: unknown): number[] | null {
  if (Array.isArray(value)) { return value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as number[]) : null; }
  if (typeof value !== "string") return null;
  const trimmed = value.trim(); if (!trimmed.startsWith("[")) return null;
  try { const parsed = JSON.parse(trimmed) as unknown; if (!Array.isArray(parsed)) return null; return parsed.every((n) => typeof n === "number" && Number.isFinite(n)) ? (parsed as number[]) : null; } catch { return null; }
}

function cosineSimilarity(a: number[], b: number[]) { if (a.length !== b.length || !a.length) return 0; let dot = 0; let normA = 0; let normB = 0; for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; } if (!normA || !normB) return 0; return dot / (Math.sqrt(normA) * Math.sqrt(normB)); }

function tokenSet(text: string) { return new Set(splitWords(keepLettersNumbersAndSpaces(toLower(text))).filter((word) => word.length >= 3)); }

function jaccardSimilarity(a: string, b: string) { const setA = tokenSet(a); const setB = tokenSet(b); if (!setA.size || !setB.size) return 0; let intersection = 0; for (const token of setA) { if (setB.has(token)) intersection += 1; } const union = setA.size + setB.size - intersection; return union > 0 ? intersection / union : 0; }

function pairSimilarity(a: MMRCandidate, b: MMRCandidate) { if (a.embedding?.length && b.embedding?.length) return cosineSimilarity(a.embedding, b.embedding); const textA = a.text?.trim() ?? ""; const textB = b.text?.trim() ?? ""; if (!textA || !textB) return 0; return jaccardSimilarity(textA, textB); }

export function selectWithMMR<T extends MMRCandidate>(candidates: T[], topK: number): T[] {
  if (!candidates.length || topK <= 0) return [];
  const lambda = mmr_readLambda();
  const maxPerPage = mmr_readMaxPerPage();
  const maxRelevance = Math.max(...candidates.map((c) => c.relevance), 1e-6);
  const pool = [...candidates].sort((a, b) => b.relevance - a.relevance);
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const pageCounts = new Map<string, number>();
  while (selected.length < topK) {
    let best: T | null = null; let bestScore = -Infinity;
    for (const candidate of pool) {
      if (selectedIds.has(candidate.id)) continue;
      const pageKey = candidate.page_id ?? candidate.id;
      if ((pageCounts.get(pageKey) ?? 0) >= maxPerPage) continue;
      const relevanceNorm = candidate.relevance / maxRelevance;
      let maxSim = 0;
      for (const picked of selected) { maxSim = Math.max(maxSim, pairSimilarity(candidate, picked)); }
      const mmrScore = lambda * relevanceNorm - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) { bestScore = mmrScore; best = candidate; }
    }
    if (!best) break;
    selected.push(best); selectedIds.add(best.id); const pageKey = best.page_id ?? best.id; pageCounts.set(pageKey, (pageCounts.get(pageKey) ?? 0) + 1);
  }
  return selected;
}

export function dedupeByTextOverlap<T extends MMRCandidate>(candidates: T[], threshold = 0.85): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    const text = candidate.text?.trim() ?? "";
    if (!text) { kept.push(candidate); continue; }
    const isDuplicate = kept.some((existing) => { const other = existing.text?.trim() ?? ""; if (!other) return false; return jaccardSimilarity(text, other) >= threshold; });
    if (!isDuplicate) kept.push(candidate);
  }
  return kept;
}

// ---- retrieval-confidence (inlined) ----
export type ChunkRetrievalHit = { chunk_id: string; page_id: string; title: string | null; final_score: number; sem_score: number; kw_score: number };
export type RetrievalConfidenceResult = { ok: boolean; reason?: string; topScore: number; avgScore: number; chunkCount: number; prefetchChars: number };

function rc_readThreshold(name: string, fallback: number) { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function getMinTopScore() { return rc_readThreshold("RETRIEVAL_MIN_TOP_SCORE", 0.16); }
function getMinAvgScore() { return rc_readThreshold("RETRIEVAL_MIN_AVG_SCORE", 0.1); }
function getStrongTopScore() { return rc_readThreshold("RETRIEVAL_STRONG_TOP_SCORE", 0.3); }
function getMinChunkCount() { return Math.max(1, Math.floor(rc_readThreshold("RETRIEVAL_MIN_CHUNKS", 2))); }

export function assessRetrievalConfidence(hits: ChunkRetrievalHit[], prefetchChars: number, loosen?: boolean): RetrievalConfidenceResult {
  const chunkCount = hits.length; const topScore = hits[0]?.final_score ?? 0; const avgScore = chunkCount > 0 ? hits.reduce((sum, hit) => sum + hit.final_score, 0) / chunkCount : 0; const prefetchCharsSafe = Math.max(0, prefetchChars);
  const minTop = loosen ? getMinTopScore() / 2 : getMinTopScore(); const minAvg = loosen ? getMinAvgScore() / 2 : getMinAvgScore(); const strongTop = loosen ? getStrongTopScore() / 2 : getStrongTopScore(); const minChunks = loosen ? Math.max(1, Math.floor(getMinChunkCount() / 2)) : getMinChunkCount(); const minPrefetch = loosen ? 200 : 400;
  if (chunkCount === 0) { if (prefetchCharsSafe >= minPrefetch) { return { ok: true, topScore: 0, avgScore: 0, chunkCount: 0, prefetchChars: prefetchCharsSafe }; } return { ok: false, reason: "no_chunks_or_prefetch", topScore: 0, avgScore: 0, chunkCount: 0, prefetchChars: prefetchCharsSafe }; }
  if (topScore >= strongTop) { return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe }; }
  if (topScore >= minTop && chunkCount >= minChunks && avgScore >= minAvg) { return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe }; }
  if (topScore >= minTop && prefetchCharsSafe >= minPrefetch) { return { ok: true, topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe }; }
  return { ok: false, reason: "low_retrieval_scores", topScore, avgScore, chunkCount, prefetchChars: prefetchCharsSafe };
}

export const RETRIEVAL_REFUSAL_MESSAGE = "I couldn’t confidently answer from the currently synced Notion data. I found some related context but it may be incomplete—try **Sync changes**, include the exact project/person/page title from Notion, or rephrase with more specific keywords.";

// ---- search-titles (inlined) ----
import { containsAnyPhrase, extractBracketContent, extractBulletLineContent, splitOnTitleSeparators, stripLeadingPrefixes } from "@/lib/shared/text-utils";

const ST_QUESTION_PREFIXES = ["can you ","summarize ","summary of ","explain ","describe ","what is ","what's ","tell me about ","provide me with ","provide ","give me ","give all data of ","give data of ","show me ","show "];
const ST_TITLE_HEAD_PREFIXES = ["what is","what's","summarize","summary of","explain","describe","tell me about","can i get","give me"];
const LINK_WORDS = ["link","url","notion"];

export function explicitTitleFromQuery(searchQuery: string) {
  const fromBrackets = extractBracketContent(searchQuery);
  if (fromBrackets && fromBrackets.length >= 3) return fromBrackets;
  for (const line of searchQuery.split("\n")) {
    const bullet = extractBulletLineContent(line);
    if (!bullet) continue;
    if (bullet.startsWith("Current question:")) continue;
    const bulletLower = toLower(bullet);
    const isShortLinkRequest = bullet.length < 80 && LINK_WORDS.some((word) => containsPhrase(bulletLower, word));
    if (isShortLinkRequest) continue;
    const head = splitOnTitleSeparators(stripLeadingPrefixes(bullet, ST_TITLE_HEAD_PREFIXES))[0];
    if (head && head.length >= 8) return head;
  }
  return null;
}

export function titleCandidates(searchQuery: string) {
  const normalized = searchQuery.split("“").join('"').split("”").join('"').split("‘").join("'").split("’").join("'");
  const spaced = splitWords(normalized).join(" ");
  const splitParts = splitOnTitleSeparators(spaced).filter((part) => part.length >= 3);
  let questionRemoved = stripLeadingPrefixes(spaced, ST_QUESTION_PREFIXES);
  const noisePhrases = ["what is","what's","core idea","main idea","summary","explain","provide","detail","details"];
  for (const phrase of noisePhrases) { const index = toLower(questionRemoved).indexOf(phrase); if (index !== -1) { questionRemoved = questionRemoved.slice(0, index).trim(); } }
  const candidates = [splitParts[0], questionRemoved, spaced].filter(Boolean);
  const unique: string[] = []; const seen = new Set<string>(); for (const item of candidates) { const key = toLower(item); if (seen.has(key)) continue; seen.add(key); unique.push(item); }
  return unique.slice(0, 3);
}

// keep previous surface exports for compatibility
export { buildNotionContextForChat, buildNotionContextWithConfidence, prefetchPagesFromQuestion } from "@/lib/rag/build-context";
export { semanticSearch } from "@/lib/rag/semantic-search";
export { hybridChunkContext, hybridChunkContextFromQueries, hasNotionChunks, runHybridChunkRetrieval } from "@/lib/rag/hybrid-search";
export { expandSearchQueries, isMultiQueryRagEnabled } from "@/lib/chat/query-tools";
