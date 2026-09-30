import { embedText } from "@/lib/ai/embeddings";
import { query, vectorQuery } from "@/lib/db";
import { simplifySearchQuery } from "@/lib/shared/search-query";
import { splitWords, keepLettersNumbersAndSpaces, toLower } from "@/lib/shared/text-utils";

type ChunkHybridRow = {
  chunk_id: string;
  page_id: string;
  chunk_index: number;
  section_heading: string | null;
  chunk_content: string | null;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  status: string | null;
  sem_score: number;
  kw_score: number;
  final_score: number;
  embedding_literal?: string | null;
};

function readPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHybridTopK() {
  return Math.floor(readPositiveNumber(process.env.HYBRID_CHUNK_TOP_K, 7));
}

function getHybridCandidateLimit() {
  return Math.floor(
    readPositiveNumber(process.env.HYBRID_CHUNK_CANDIDATES, 60),
  );
}

function readFloatEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function applyRelevanceFloor(rows: ChunkHybridRow[]) {
  if (rows.length <= 1) return rows;
  const topScore = rows[0].final_score;
  if (topScore <= 0) return rows;
  const ratio = readFloatEnv("HYBRID_RELATIVE_FLOOR_RATIO", 0.45);
  const floor = topScore * ratio;
  const kept = rows.filter((row) => row.final_score >= floor);
  return kept.length ? kept : rows.slice(0, 1);
}

function refineChunkResults(rows: ChunkHybridRow[], topK: number) {
  if (!rows.length) return rows;

  const floored = applyRelevanceFloor(
    [...rows].sort((a, b) => b.final_score - a.final_score),
  );

  const candidates: (ChunkHybridRow & MMRCandidate)[] = floored.map((row) => ({
    ...row,
    id: row.chunk_id,
    relevance: row.final_score,
    embedding: parsePgVector(row.embedding_literal),
    text: row.chunk_content ?? "",
    page_id: row.page_id,
  }));

  const deduped = dedupeByTextOverlap(candidates, 0.88);
  if (!isMmrEnabled()) {
    return deduped.slice(0, topK);
  }

  return selectWithMMR(deduped, topK);
}

function getMaxContextChars() {
  return Math.floor(
    readPositiveNumber(process.env.VECTOR_SEARCH_MAX_CONTEXT_CHARS, 32000),
  );
}

function yearWindow(year?: number) {
  if (!year) return null;
  return {
    start: `${year}-01-01`,
    end: `${year + 1}-01-01`,
  };
}

function getSemWeight() {
  const w = Number(process.env.HYBRID_SEM_WEIGHT);
  return Number.isFinite(w) && w >= 0 && w <= 1 ? w : 0.6;
}

function getKwWeight() {
  const w = Number(process.env.HYBRID_KW_WEIGHT);
  return Number.isFinite(w) && w >= 0 && w <= 1 ? w : 0.4;
}

export async function hasNotionChunks(): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM notion_chunks LIMIT 1) AS exists`,
  );
  return rows[0]?.exists ?? false;
}

function formatChunkContext(rows: ChunkHybridRow[]) {
  const maxChars = getMaxContextChars();
  const sections: string[] = [];
  let chars = 0;

  for (const row of rows) {
    const title = row.title || "Untitled";
    const label = row.section_heading
      ? `${title} > ${row.section_heading}`
      : title;
    const url = row.url || "";
    const owner = row.owner || "Unknown";
    const createdBy = row.created_by || "Unknown";
    const status = row.status || "Unknown";
    const body = (row.chunk_content || "").trim();
    const clipped = body.length > 6000 ? `${body.slice(0, 6000)}...` : body;

    const section = [
      `[${label}]`,
      url ? `URL: ${url}` : "",
      `Owner: ${owner}`,
      `Created by: ${createdBy}`,
      `Status: ${status}`,
      `Chunk index: ${row.chunk_index}`,
      "",
      "=== CHUNK START ===",
      clipped || "(empty chunk)",
      "=== CHUNK END ===",
    ]
      .filter(Boolean)
      .join("\n");

    if (sections.length > 0 && chars + section.length > maxChars) break;
    sections.push(section);
    chars += section.length;
  }

  return sections.join("\n\n---\n\n");
}

/** Merge chunk rows from multiple queries; keep the best score per chunk. */
export function mergeHybridChunkRows(
  rowSets: ChunkHybridRow[][],
): ChunkHybridRow[] {
  const byId = new Map<string, ChunkHybridRow>();

  for (const rows of rowSets) {
    for (const row of rows) {
      const existing = byId.get(row.chunk_id);
      if (!existing || row.final_score > existing.final_score) {
        byId.set(row.chunk_id, row);
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.final_score - a.final_score);
}

/**
 * Hybrid retrieval over `notion_chunks` (raw rows, before MMR).
 * Falls back to FTS-only when the query embedding is unavailable.
 */
export async function fetchHybridChunkRows(
  searchQuery: string,
  titleBoost?: string,
  options?: { year?: number },
): Promise<ChunkHybridRow[]> {
  const raw = searchQuery.trim();
  if (!raw) return [];

  const boostTitle = titleBoost?.trim() || "";
  const boostPattern = boostTitle
    ? `%${boostTitle.replace(/[%_\\]/g, "")}%`
    : "";
  const ftsInput = simplifySearchQuery(boostTitle || raw).trim() || raw.trim();
  // FIX (Accuracy): `c.fts @@ plainto_tsquery(...)` requires an exact
  // lexeme match — a genuine typo ("polcy" for "policy") never matches no
  // matter which text-search config is used, since typo'd tokens don't
  // stem/normalize to the correct lexeme. `$N <% c.content` (pg_trgm
  // word_similarity, index-backed by notion_chunks_content_trgm_idx) is
  // OR'd in below as a fallback so typo'd queries still surface candidates.
  // Uses the default pg_trgm.word_similarity_threshold (0.6) — tune via
  // `SET pg_trgm.word_similarity_threshold = ...` if this proves too
  // loose/tight against real query traffic.
  const cand = getHybridCandidateLimit();
  const wSem = getSemWeight();
  const wKw = getKwWeight();
  const wSum = wSem + wKw > 0 ? wSem + wKw : 1;
  const bounds = yearWindow(options?.year);

  const embedding = await embedText(raw);
  const vectorLiteral = embedding ? `[${embedding.join(",")}]` : null;

  const embeddingSelect = isMmrEnabled()
    ? "c.embedding::text AS embedding_literal"
    : "NULL AS embedding_literal";

  const dbStart = Date.now();
  const logDbTiming = (rows: ChunkHybridRow[]) => {
    if (process.env.CHAT_DEBUG === "true") {
      console.log("[db-timing] hybrid chunk query", {
        searchQuery: raw.slice(0, 60),
        rows: rows.length,
        candidateLimit: cand,
        usedVector: Boolean(vectorLiteral),
        ms: Date.now() - dbStart,
      });
    }
    return rows;
  };

   if (vectorLiteral) {
    return bounds
      ? vectorQuery<ChunkHybridRow>(
          `
          WITH sem AS (
            SELECT
              c.id,
              1 - (c.embedding <=> $1::vector) AS sem_score
            FROM notion_chunks c
            JOIN notion_pages p ON p.id = c.page_id
            WHERE c.embedding IS NOT NULL
              AND p.notion_edited_at >= $8::timestamptz
              AND p.notion_edited_at < $9::timestamptz
            ORDER BY c.embedding <=> $1::vector ASC
            LIMIT $3
          ),
          kw AS (
            SELECT
              c.id,
              LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $2)))::float8 AS kw_score
            FROM notion_chunks c
            JOIN notion_pages p ON p.id = c.page_id
            WHERE (c.fts @@ plainto_tsquery('simple', $2) OR $2 <% c.content)
              AND p.notion_edited_at >= $8::timestamptz
              AND p.notion_edited_at < $9::timestamptz
            ORDER BY kw_score DESC NULLS LAST
            LIMIT $3
          ),
          ids AS (
            SELECT id FROM sem
            UNION
            SELECT id FROM kw
          )
          SELECT
            c.id AS chunk_id,
            c.page_id,
            c.chunk_index,
            c.section_heading,
            c.content AS chunk_content,
            p.title,
            p.url,
            p.owner,
            p.created_by,
            p.status,
            COALESCE(sem.sem_score, 0)::float8 AS sem_score,
            COALESCE(kw.kw_score, 0)::float8 AS kw_score,
            (
              ($4 * COALESCE(sem.sem_score, 0) + $5 * COALESCE(kw.kw_score, 0)) / $6
              + CASE
  WHEN $7 <> '' AND lower(coalesce(p.title, '')) = lower(replace($7, '%', ''))
    THEN 0.40
  WHEN $7 <> '' AND lower(coalesce(p.title, '')) LIKE lower($7)
    THEN 0.20
  ELSE 0
END
            )::float8 AS final_score,
            ${embeddingSelect}
          FROM ids
          JOIN notion_chunks c ON c.id = ids.id
          JOIN notion_pages p ON p.id = c.page_id
          LEFT JOIN sem ON sem.id = c.id
          LEFT JOIN kw ON kw.id = c.id
          WHERE p.notion_edited_at >= $8::timestamptz
            AND p.notion_edited_at < $9::timestamptz
          ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
          LIMIT $3
          `,
          [vectorLiteral, ftsInput, cand, wSem, wKw, wSum, boostPattern, bounds.start, bounds.end],
        ).then(logDbTiming)
      : vectorQuery<ChunkHybridRow>(
          `
          WITH sem AS (
            SELECT
              c.id,
              1 - (c.embedding <=> $1::vector) AS sem_score
            FROM notion_chunks c
            WHERE c.embedding IS NOT NULL
            ORDER BY c.embedding <=> $1::vector ASC
            LIMIT $3
          ),
          kw AS (
            SELECT
              c.id,
              LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $2)))::float8 AS kw_score
            FROM notion_chunks c
            WHERE (c.fts @@ plainto_tsquery('simple', $2) OR $2 <% c.content)
            ORDER BY kw_score DESC NULLS LAST
            LIMIT $3
          ),
          ids AS (
            SELECT id FROM sem
            UNION
            SELECT id FROM kw
          )
          SELECT
            c.id AS chunk_id,
            c.page_id,
            c.chunk_index,
            c.section_heading,
            c.content AS chunk_content,
            p.title,
            p.url,
            p.owner,
            p.created_by,
            p.status,
            COALESCE(sem.sem_score, 0)::float8 AS sem_score,
            COALESCE(kw.kw_score, 0)::float8 AS kw_score,
            (
              ($4 * COALESCE(sem.sem_score, 0) + $5 * COALESCE(kw.kw_score, 0)) / $6
              + CASE
  WHEN $7 <> '' AND lower(coalesce(p.title, '')) = lower(replace($7, '%', ''))
    THEN 0.40
  WHEN $7 <> '' AND lower(coalesce(p.title, '')) LIKE lower($7)
    THEN 0.20
  ELSE 0
END
            )::float8 AS final_score,
            ${embeddingSelect}
          FROM ids
          JOIN notion_chunks c ON c.id = ids.id
          JOIN notion_pages p ON p.id = c.page_id
          LEFT JOIN sem ON sem.id = c.id
          LEFT JOIN kw ON kw.id = c.id
          ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
          LIMIT $3
          `,
          [vectorLiteral, ftsInput, cand, wSem, wKw, wSum, boostPattern],
        ).then(logDbTiming);
  }

  return bounds
    ? query<ChunkHybridRow>(
        `
          SELECT
            c.id AS chunk_id,
            c.page_id,
            c.chunk_index,
            c.section_heading,
            c.content AS chunk_content,
            p.title,
            p.url,
            p.owner,
            p.created_by,
            p.status,
            0::float8 AS sem_score,
            LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $1)))::float8 AS kw_score,
            LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $1)))::float8 AS final_score
          FROM notion_chunks c
          JOIN notion_pages p ON p.id = c.page_id
          WHERE (c.fts @@ plainto_tsquery('simple', $1) OR $1 <% c.content)
            AND p.notion_edited_at >= $2::timestamptz
            AND p.notion_edited_at < $3::timestamptz
          ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
          LIMIT $4
        `,
        [ftsInput, bounds.start, bounds.end, cand],
      ).then(logDbTiming)
    : query<ChunkHybridRow>(
        `
          SELECT
            c.id AS chunk_id,
            c.page_id,
            c.chunk_index,
            c.section_heading,
            c.content AS chunk_content,
            p.title,
            p.url,
            p.owner,
            p.created_by,
            p.status,
            0::float8 AS sem_score,
            LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $1)))::float8 AS kw_score,
            LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('simple', $1)))::float8 AS final_score
          FROM notion_chunks c
          JOIN notion_pages p ON p.id = c.page_id
          WHERE (c.fts @@ plainto_tsquery('simple', $1) OR $1 <% c.content)
          ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
          LIMIT $2
        `,
        [ftsInput, cand],
      ).then(logDbTiming);
}

export type HybridChunkRetrieval = {
  rows: ChunkHybridRow[];
  context: string | null;
  queries: string[];
};

/** Runs `fn` over `items`, at most `limit` in flight at once. */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

/** Hybrid search with scores (for confidence gate + diagnostics). */
export async function runHybridChunkRetrieval(
  searchQueries: string[],
  titleBoost?: string,
  options?: { year?: number },
): Promise<HybridChunkRetrieval> {
  const unique = [
    ...new Set(searchQueries.map((q) => q.trim()).filter(Boolean)),
  ];
  if (!unique.length) {
    return { rows: [], context: null, queries: [] };
  }

  const topK = getHybridTopK();
  const rowSets = await runWithConcurrencyLimit(
    unique,
    (q) => fetchHybridChunkRows(q, titleBoost, options),
    2,
  );

  const merged = mergeHybridChunkRows(rowSets);

  if (!merged.length) {
    return { rows: [], context: null, queries: unique };
  }

  const refined = refineChunkResults(merged, topK);
  return {
    rows: refined,
    context: formatChunkContext(refined),
    queries: unique,
  };
}

/**
 * Multi-Query RAG: run hybrid search for each query, merge, then MMR + format.
 */
export async function hybridChunkContextFromQueries(
  searchQueries: string[],
  options?: { year?: number },
): Promise<string | null> {
  const { context, rows, queries } =
    await runHybridChunkRetrieval(searchQueries, undefined, options);

  if (process.env.NODE_ENV !== "production" && rows.length) {
    console.log("[retrieval] multi_query_chunks", {
      queries: queries.length,
      candidates: rows.length,
      selected: rows.length,
      mmr: isMmrEnabled(),
      top_score: rows[0]?.final_score,
    });
  }

  return context;
}

/**
 * Hybrid retrieval over `notion_chunks`: vector similarity + FTS, merged with weighted score.
 * Falls back to FTS-only when the query embedding is unavailable.
 */
export async function hybridChunkContext(
  searchQuery: string,
  options?: { year?: number },
): Promise<string | null> {
  return hybridChunkContextFromQueries([searchQuery], options);
}

// ─── MMR / dedupe helpers ───
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
  if (a.embedding?.length && b.embedding?.length) return cosineSimilarity(a.embedding, b.embedding);
  const textA = a.text?.trim() ?? "";
  const textB = b.text?.trim() ?? "";
  if (!textA || !textB) return 0;
  return jaccardSimilarity(textA, textB);
}

export function selectWithMMR<T extends MMRCandidate>(candidates: T[], topK: number): T[] {
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