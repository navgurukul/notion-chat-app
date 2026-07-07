import { query } from "@/lib/db";
import { ResolutionQuality } from "./person";
import { isNoiseTopic } from "@/lib/query/normalize";

export type ResolvedDocument = {
  value: string | null;
  url: string | null;
  quality: ResolutionQuality;
};

type CacheEntry = {
  value: ResolvedDocument;
  expiry: number;
};

const docCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 1000;

function getCacheKey(topic: string): string {
  return topic.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of docCache.entries()) {
    if (now > entry.expiry) {
      docCache.delete(key);
    }
  }
}

function stripDocWords(value: string): string {
  return value
    .replace(
      /\b(page|doc|document|docs|pages|project|projects|task|tasks|work|worked|assigned|assign|assignee|given|got|to|the|a|an|all|every|some|any|only|one|feature|features)\b/gi,
      "",
    )
    .replace(/^(what|which|who|where|when|why|how|was|is)\s+/i, "")
    .replace(/'s\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function computeMatchScore(topic: string, title: string): { score: number; quality: ResolutionQuality } {
  const tLow = topic.toLowerCase().trim();
  const titleLow = title.toLowerCase().trim();

  if (tLow === titleLow) {
    return { score: 1.00, quality: ResolutionQuality.EXACT };
  }

  // Normalize: remove extra spaces and punctuation
  const tNorm = tLow.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ");
  const titleNorm = titleLow.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ");
  if (tNorm === titleNorm) {
    return { score: 0.97, quality: ResolutionQuality.EXACT };
  }

  if (titleNorm.startsWith(tNorm)) {
    return { score: 0.94, quality: ResolutionQuality.PARTIAL };
  }

  const escaped = tNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRegex = new RegExp(`\\b${escaped}\\b`, "i");
  if (wordRegex.test(titleNorm)) {
    return { score: 0.85, quality: ResolutionQuality.PARTIAL };
  }

  // Token overlap match
  const tTokens = new Set(tNorm.split(/\s+/).filter(tok => tok.length > 2));
  const titleTokens = new Set(titleNorm.split(/\s+/).filter(tok => tok.length > 2));
  if (tTokens.size > 0 && titleTokens.size > 0) {
    let intersection = 0;
    for (const tok of tTokens) {
      if (titleTokens.has(tok)) intersection++;
    }
    const overlap = intersection / Math.max(tTokens.size, titleTokens.size);
    if (overlap >= 0.5) {
      return { score: 0.80 * overlap, quality: ResolutionQuality.PARTIAL };
    }
  }

  return { score: 0.0, quality: ResolutionQuality.NONE };
}

export async function resolveDocument(topic: string): Promise<ResolvedDocument> {
  const trimmed = topic.trim();
  if (trimmed.length < 2 || isNoiseTopic(trimmed)) {
    return { value: null, url: null, quality: ResolutionQuality.NONE };
  }

  const cacheKey = getCacheKey(trimmed);
  cleanCache();
  const cached = docCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  // Fetch candidate pages
  const pages = await query<{ title: string | null; url: string | null }>(
    `SELECT title, url FROM notion_pages WHERE title IS NOT NULL AND trim(title) <> ''`
  );

  let bestMatch: { title: string; url: string | null; score: number; quality: ResolutionQuality } | null = null;

  // Helper to find the best matching candidate
  const matchAgainst = (searchTopic: string) => {
    for (const page of pages) {
      if (!page.title) continue;
      const { score, quality } = computeMatchScore(searchTopic, page.title);
      if (score >= 0.80 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { title: page.title, url: page.url, score, quality };
      }
    }
  };

  // 1. Search exact/partial first
  matchAgainst(trimmed);

  // 2. Search-before-strip fallback
  if (!bestMatch) {
    const stripped = stripDocWords(trimmed);
    if (stripped !== trimmed && stripped.length >= 2) {
      matchAgainst(stripped);
    }
  }

  const result: ResolvedDocument = bestMatch
    ? { value: (bestMatch as any).title, url: (bestMatch as any).url, quality: (bestMatch as any).quality }
    : { value: null, url: null, quality: ResolutionQuality.NONE };

  // Save to cache
  if (docCache.size >= MAX_CACHE_SIZE) {
    const firstKey = docCache.keys().next().value;
    if (firstKey !== undefined) docCache.delete(firstKey);
  }
  docCache.set(cacheKey, { value: result, expiry: Date.now() + CACHE_TTL_MS });

  return result;
}
