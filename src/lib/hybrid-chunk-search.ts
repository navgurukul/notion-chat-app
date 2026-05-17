import { embedText } from "@/lib/embeddings";
import { query } from "@/lib/postgres";
import { simplifySearchQuery } from "@/lib/search-query";

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
};

function readPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getHybridTopK() {
  return Math.floor(readPositiveNumber(process.env.HYBRID_CHUNK_TOP_K, 7));
}

function getHybridCandidateLimit() {
  return Math.floor(readPositiveNumber(process.env.HYBRID_CHUNK_CANDIDATES, 40));
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

/**
 * Hybrid retrieval over `notion_chunks`: vector similarity + FTS, merged with weighted score.
 * Falls back to FTS-only when the query embedding is unavailable.
 */
export async function hybridChunkContext(searchQuery: string): Promise<string | null> {
  const raw = searchQuery.trim();
  if (!raw) return null;

  const ftsInput = simplifySearchQuery(raw).trim() || raw.trim();
  const topK = getHybridTopK();
  const cand = getHybridCandidateLimit();
  const wSem = getSemWeight();
  const wKw = getKwWeight();
  const wSum = wSem + wKw > 0 ? wSem + wKw : 1;

  const embedding = await embedText(raw);
  const vectorLiteral = embedding ? `[${embedding.join(",")}]` : null;

  let rows: ChunkHybridRow[];

  if (vectorLiteral) {
    rows = await query<ChunkHybridRow>(
      `
      WITH sem AS (
        SELECT
          c.id,
          1 - (c.embedding <=> $1::vector) AS sem_score
        FROM notion_chunks c
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $1::vector ASC
        LIMIT $4
      ),
      kw AS (
        SELECT
          c.id,
          LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('english', $2)))::float8 AS kw_score
        FROM notion_chunks c
        WHERE c.fts @@ plainto_tsquery('english', $2)
        ORDER BY kw_score DESC NULLS LAST
        LIMIT $4
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
        (($5 * COALESCE(sem.sem_score, 0) + $6 * COALESCE(kw.kw_score, 0)) / $7)::float8 AS final_score
      FROM ids
      JOIN notion_chunks c ON c.id = ids.id
      JOIN notion_pages p ON p.id = c.page_id
      LEFT JOIN sem ON sem.id = c.id
      LEFT JOIN kw ON kw.id = c.id
      ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
      LIMIT $3
      `,
      [vectorLiteral, ftsInput, topK, cand, wSem, wKw, wSum],
    );
  } else {
    rows = await query<ChunkHybridRow>(
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
      [ftsInput, topK],
    );
  }

  if (!rows.length) return null;
  return formatChunkContext(rows);
}
