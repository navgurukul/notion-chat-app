import { embedText } from "@/lib/embeddings";
import { query } from "@/lib/postgres";

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

function getMinSimilarity() {
  return readPositiveNumber(process.env.VECTOR_SEARCH_MIN_SIMILARITY, DEFAULT_MIN_SIMILARITY);
}

function getMaxContextChars() {
  return Math.floor(
    readPositiveNumber(process.env.VECTOR_SEARCH_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS),
  );
}

function simplifySearchQuery(searchQuery: string) {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "by",
    "can",
    "doc",
    "docs",
    "document",
    "documents",
    "for",
    "from",
    "give",
    "is",
    "me",
    "of",
    "on",
    "owner",
    "owned",
    "page",
    "pages",
    "please",
    "provide",
    "related",
    "show",
    "status",
    "the",
    "to",
    "type",
    "what",
    "which",
    "who",
    "whose",
  ]);

  const keywords = searchQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !stopWords.has(word));

  return keywords.join(" ").trim() || searchQuery.trim();
}

function escapeLike(value: string) {
  return value.replace(/[%_]/g, "\\$&");
}

function titleCandidates(searchQuery: string) {
  const normalized = searchQuery
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const splitCandidates = normalized
    .split(/\s+(?:—|–|-|:)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  const questionRemoved = normalized
    .replace(/^(summarize|summary of|explain|describe|what is|what's|tell me about)\s+/i, "")
    .replace(/\b(what is|what's|core idea|main idea|summary|explain)\b.*$/i, "")
    .trim();

  return Array.from(new Set([splitCandidates[0], questionRemoved, normalized].filter(Boolean))).slice(0, 3);
}

function titleKeywords(searchQuery: string) {
  return simplifySearchQuery(searchQuery)
    .replace(/\b(summarize|summary|explain|describe|details?|detail|about|document|proposal|core|idea|main)\b/gi, " ")
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
  const minSimilarity = getMinSimilarity();

  const rows = await query<SearchRow>(
    `
    SELECT
      id,
      title,
      url,
      owner,
      created_by,
      status,
      content,
      1 - (embedding <=> $1::vector) AS similarity
    FROM notion_pages
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) >= $2
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $3
    `,
    [vectorLiteral, minSimilarity, topK],
  );

  return rows;
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
  if (terms.length < 2) return [];

  return query<SearchRow>(
    `
    SELECT id, title, url, owner, created_by, status, content, 50 AS rank
    FROM notion_pages
    WHERE ${terms
      .map((_, index) => `lower(coalesce(title, '')) LIKE lower($${index + 1}) ESCAPE '\\'`)
      .join(" AND ")}
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
    [cleanedQuery, topK],
  );

  if (rows.length) return rows;

  const terms = cleanedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (!terms.length) return [];

  return query<SearchRow>(
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
    [...terms.map((term) => `%${term.replace(/[%_]/g, "\\$&")}%`), topK],
  );
}

export async function semanticSearch(searchQuery: string): Promise<string> {
  const cleaned = searchQuery.trim();
  if (!cleaned) return "";

  let rows: SearchRow[] = [];
  const titleRows = await titleSearch(cleaned);
  const embeddingsAvailable = await hasEmbeddings();

  if (embeddingsAvailable) {
    rows = await vectorSearch(cleaned);
  }

  if (!rows.length) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[search] using full-text fallback");
    }
    rows = await fullTextSearch(cleaned);
  }

  rows = mergeSearchRows(titleRows, rows);

  if (!rows.length) return "";
  return formatContext(rows);
}
