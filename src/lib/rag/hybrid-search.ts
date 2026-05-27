import { embedText } from "@/lib/ai/embeddings";
import { query } from "@/lib/db";
import {
  dedupeByTextOverlap,
  isMmrEnabled,
  parsePgVector,
  selectWithMMR,
  type MMRCandidate,
} from "@/lib/rag/mmr";
import { simplifySearchQuery } from "@/lib/shared/search-query";

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
  return Math.floor(readPositiveNumber(process.env.HYBRID_CHUNK_CANDIDATES, 60));
}

function refineChunkResults(rows: ChunkHybridRow[], topK: number) {
  if (!rows.length) return rows;

  const candidates: (ChunkHybridRow & MMRCandidate)[] = rows.map((row) => ({
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
    const label = row.section_heading ? `${title} > ${row.section_heading}` : title;
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
export function mergeHybridChunkRows(rowSets: ChunkHybridRow[][]): ChunkHybridRow[] {
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
): Promise<ChunkHybridRow[]> {
  const raw = searchQuery.trim();
  if (!raw) return [];

  const boostTitle = titleBoost?.trim() || "";
  const boostPattern = boostTitle ? `%${boostTitle.replace(/[%_\\]/g, "")}%` : "";
  const ftsInput = simplifySearchQuery(boostTitle || raw).trim() || raw.trim();
  const cand = getHybridCandidateLimit();
  const wSem = getSemWeight();
  const wKw = getKwWeight();
  const wSum = wSem + wKw > 0 ? wSem + wKw : 1;

  const embedding = await embedText(raw);
  const vectorLiteral = embedding ? `[${embedding.join(",")}]` : null;

  if (vectorLiteral) {
    return query<ChunkHybridRow>(
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
          LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('english', $2)))::float8 AS kw_score
        FROM notion_chunks c
        WHERE c.fts @@ plainto_tsquery('english', $2)
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
              WHEN $7 <> '' AND lower(coalesce(p.title, '')) LIKE lower($7) THEN 0.2
              ELSE 0
            END
        )::float8 AS final_score,
        c.embedding::text AS embedding_literal
      FROM ids
      JOIN notion_chunks c ON c.id = ids.id
      JOIN notion_pages p ON p.id = c.page_id
      LEFT JOIN sem ON sem.id = c.id
      LEFT JOIN kw ON kw.id = c.id
      ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
      LIMIT $3
      `,
      [vectorLiteral, ftsInput, cand, wSem, wKw, wSum, boostPattern],
    );
  }

  return query<ChunkHybridRow>(
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
        LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('english', $1)))::float8 AS kw_score,
        LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('english', $1)))::float8 AS final_score
      FROM notion_chunks c
      JOIN notion_pages p ON p.id = c.page_id
      WHERE c.fts @@ plainto_tsquery('english', $1)
      ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
      LIMIT $2
      `,
      [ftsInput, cand],
    );
}

export type HybridChunkRetrieval = {
  rows: ChunkHybridRow[];
  context: string | null;
  queries: string[];
};

/** Hybrid search with scores (for confidence gate + diagnostics). */
export async function runHybridChunkRetrieval(
  searchQueries: string[],
  titleBoost?: string,
): Promise<HybridChunkRetrieval> {
  const unique = [...new Set(searchQueries.map((q) => q.trim()).filter(Boolean))];
  if (!unique.length) {
    return { rows: [], context: null, queries: [] };
  }

  const topK = getHybridTopK();
  const rowSets = await Promise.all(
    unique.map((q) => fetchHybridChunkRows(q, titleBoost)),
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
): Promise<string | null> {
  const { context, rows, queries } = await runHybridChunkRetrieval(searchQueries);

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
export async function hybridChunkContext(searchQuery: string): Promise<string | null> {
  return hybridChunkContextFromQueries([searchQuery]);
}
