import { escapeLike } from "@/lib/db/sql-utils";
import { embedText } from "@/lib/ai/embeddings";
import {
  hasNotionChunks,
  hybridChunkContext,
  hybridChunkContextFromQueries,
} from "@/lib/rag/hybrid-search";
import {
  dedupeByTextOverlap,
  isMmrEnabled,
  parsePgVector,
  selectWithMMR,
  type MMRCandidate,
} from "@/lib/rag/mmr";
import { query } from "@/lib/db";
import {
  explicitTitleFromQuery,
  titleCandidates,
} from "@/lib/rag/search-titles";
import { simplifySearchQuery } from "@/lib/shared/search-query";

type SearchRow = {
  id: string;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  status: string | null;
  content: string | null;
  similarity?: number;
  rank?: number;
};

const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_MAX_CONTEXT_CHARS = 32000;

function readPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTopK() {
  return Math.floor(readPositiveNumber(process.env.VECTOR_SEARCH_TOP_K, DEFAULT_TOP_K));
}

function getPageCandidateLimit() {
  const topK = getTopK();
  return Math.floor(readPositiveNumber(process.env.VECTOR_SEARCH_CANDIDATES, topK * 3));
}

function refinePageRows(rows: SearchRow[], topK: number): SearchRow[] {
  if (!rows.length) return rows;

  const candidates = rows.map((row) => ({
    ...row,
    id: row.id,
    relevance: row.similarity ?? row.rank ?? 0,
    embedding: parsePgVector((row as SearchRow & { embedding_literal?: string }).embedding_literal),
    text: `${row.title ?? ""}\n${row.content ?? ""}`.slice(0, 8000),
    page_id: row.id,
  })) as (SearchRow & MMRCandidate)[];

  const deduped = dedupeByTextOverlap(candidates, 0.85);
  if (!isMmrEnabled()) return deduped.slice(0, topK);
  return selectWithMMR(deduped, topK);
}

function getMinSimilarity() {
  return readPositiveNumber(process.env.VECTOR_SEARCH_MIN_SIMILARITY, DEFAULT_MIN_SIMILARITY);
}

function getMaxContextChars() {
  return Math.floor(
    readPositiveNumber(process.env.VECTOR_SEARCH_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS),
  );
}

function titleKeywords(searchQuery: string) {
  return simplifySearchQuery(searchQuery)
    .replace(/\b(summarize|summary|summry|sumry|explain|describe|details?|detail|about|document|proposal|core|idea|main)\b/gi, " ")
    .replace(/\b(provide|give|show|fetched|fetvhed|notion|link|project|data|info|inside|above)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 6);
}

function formatContext(rows: SearchRow[]) {
  const maxChars = getMaxContextChars();
  const sections: string[] = [];
  let chars = 0;

  for (const row of rows) {
    const title = row.title || "Untitled";
    const url = row.url || "";
    const owner = row.owner || "Unknown";
    const createdBy = row.created_by || "Unknown";
    const status = row.status || "Unknown";
    const content = (row.content || "").trim();
    const body = content.length > 4000 ? `${content.slice(0, 4000)}...` : content;

    const section = [
      `Title: ${title}`,
      url ? `URL: ${url}` : "",
      `Owner: ${owner}`,
      `Created by: ${createdBy}`,
      `Status: ${status}`,
      "",
      "=== DOCUMENT START ===",
      body || "No content available.",
      "=== DOCUMENT END ===",
    ]
      .filter(Boolean)
      .join("\n");

    if (sections.length > 0 && chars + section.length > maxChars) break;
    sections.push(section);
    chars += section.length;
  }

  return sections.join("\n\n---\n\n");
}

async function hasEmbeddings() {
  const rows = await query<{ has_embeddings: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM notion_pages
      WHERE embedding IS NOT NULL
    ) AS has_embeddings
    `,
  );
  return rows[0]?.has_embeddings ?? false;
}

async function vectorSearch(searchQuery: string) {
  const embedding = await embedText(searchQuery);
  if (!embedding) return [];

  const vectorLiteral = `[${embedding.join(",")}]`;
  const topK = getTopK();
  const cand = getPageCandidateLimit();
  const minSimilarity = getMinSimilarity();

  const rows = await query<SearchRow & { embedding_literal?: string }>(
    `
    SELECT
      id,
      title,
      url,
      owner,
      created_by,
      status,
      content,
      1 - (embedding <=> $1::vector) AS similarity,
      embedding::text AS embedding_literal
    FROM notion_pages
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) >= $2
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $3
    `,
    [vectorLiteral, minSimilarity, cand],
  );

  return refinePageRows(rows, topK);
}

async function titleSearch(searchQuery: string) {
  const candidates = titleCandidates(searchQuery);
  for (const candidate of candidates) {
    const rows = await query<SearchRow>(
      `
      SELECT id, title, url, owner, created_by, status, content, 100 AS rank
      FROM notion_pages
      WHERE lower(coalesce(title, '')) = lower($1)
         OR lower(coalesce(title, '')) LIKE lower($2) ESCAPE '\\'
      ORDER BY
        CASE WHEN lower(coalesce(title, '')) = lower($1) THEN 0 ELSE 1 END,
        length(coalesce(title, '')) ASC,
        title ASC
      LIMIT 5
      `,
      [candidate, `%${escapeLike(candidate)}%`],
    );
    if (rows.length) return rows;
  }

  const terms = titleKeywords(searchQuery);
  if (!terms.length) return [];

  return query<SearchRow>(
    `
    SELECT id, title, url, owner, created_by, status, content, 50 AS rank
    FROM notion_pages
    WHERE ${
      terms.length === 1
        ? `lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'`
        : terms
            .map((_, index) => `lower(coalesce(title, '')) LIKE lower($${index + 1}) ESCAPE '\\'`)
            .join(" AND ")
    }
    ORDER BY length(coalesce(title, '')) ASC, title ASC
    LIMIT $${terms.length + 1}
    `,
    [...terms.map((term) => `%${escapeLike(term)}%`), 5],
  );
}

function mergeSearchRows(primary: SearchRow[], secondary: SearchRow[]) {
  const seen = new Set(primary.map((row) => row.id));
  return [...primary, ...secondary.filter((row) => !seen.has(row.id))];
}

async function fullTextSearch(searchQuery: string) {
  const topK = getTopK();
  const cand = getPageCandidateLimit();
  const cleanedQuery = simplifySearchQuery(searchQuery);

  const rows = await query<SearchRow>(
    `
    WITH ranked AS (
      SELECT
        id,
        title,
        url,
        owner,
        created_by,
        status,
        content,
        (
          ts_rank(
            to_tsvector('english', coalesce(content, '')),
            plainto_tsquery('english', $1)
          ) +
          2 * ts_rank(
            to_tsvector('english', coalesce(title, '')),
            plainto_tsquery('english', $1)
          )
        ) AS rank
      FROM notion_pages
      WHERE
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
        @@ plainto_tsquery('english', $1)
    )
    SELECT id, title, url, owner, created_by, status, content, rank
    FROM ranked
    ORDER BY rank DESC
    LIMIT $2
    `,
    [cleanedQuery, cand],
  );

  if (rows.length) return refinePageRows(rows, topK);

  const terms = cleanedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (!terms.length) return [];

  const fallback = await query<SearchRow>(
    `
    SELECT id, title, url, owner, created_by, status, content, 0 AS rank
    FROM notion_pages
    WHERE ${terms
      .map(
        (_, index) =>
          `(lower(coalesce(title, '')) LIKE lower($${index + 1}) ESCAPE '\\'
            OR lower(coalesce(content, '')) LIKE lower($${index + 1}) ESCAPE '\\')`,
      )
      .join(" OR ")}
    ORDER BY
      ${terms
        .map(
          (_, index) =>
            `CASE WHEN lower(coalesce(title, '')) LIKE lower($${index + 1}) ESCAPE '\\' THEN 0 ELSE 1 END`,
        )
        .join(", ")},
      title ASC
    LIMIT $${terms.length + 1}
    `,
    [...terms.map((term) => `%${term.replace(/[%_]/g, "\\$&")}%`), cand],
  );

  return refinePageRows(fallback, topK);
}

function normalizeSearchQueries(
  searchQuery: string | string[],
): { primary: string; all: string[] } {
  const list = (Array.isArray(searchQuery) ? searchQuery : [searchQuery])
    .map((q) => q.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const all: string[] = [];
  for (const q of list) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(q);
  }

  return { primary: all[0] ?? "", all };
}

export async function semanticSearch(searchQuery: string | string[]): Promise<string> {
  const { primary: cleaned, all: queries } = normalizeSearchQueries(searchQuery);
  if (!cleaned) return "";

  const explicitTitle = explicitTitleFromQuery(cleaned);
  const titleRows = explicitTitle
    ? mergeSearchRows(await titleSearch(explicitTitle), await titleSearch(cleaned))
    : await titleSearch(cleaned);

  if (await hasNotionChunks()) {
    const chunkPart =
      queries.length > 1
        ? await hybridChunkContextFromQueries(queries)
        : await hybridChunkContext(cleaned);
    if (chunkPart) {
      const titlePart = titleRows.length ? `${formatContext(titleRows)}\n\n---\n\n` : "";
      return `${titlePart}${chunkPart}`;
    }
  }

  let rows: SearchRow[] = [];
  const embeddingsAvailable = await hasEmbeddings();

  if (embeddingsAvailable) {
    const vectorSets = await Promise.all(queries.map((q) => vectorSearch(q)));
    const seen = new Set<string>();
    for (const set of vectorSets) {
      for (const row of set) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }

  if (!rows.length) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[search] using full-text fallback");
    }
    const ftsSets = await Promise.all(queries.map((q) => fullTextSearch(q)));
    const seen = new Set<string>();
    for (const set of ftsSets) {
      for (const row of set) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }

  rows = mergeSearchRows(titleRows, rows);

  if (!rows.length) return "";
  return formatContext(rows);
}
