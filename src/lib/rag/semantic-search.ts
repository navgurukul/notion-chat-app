import { escapeLike } from "@/lib/db/sql-utils";
import { embedText } from "@/lib/ai/embeddings";
import { hasNotionChunks, hybridChunkContext } from "@/lib/rag/hybrid-search";
import { query } from "@/lib/db";
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

function getMinSimilarity() {
  return readPositiveNumber(process.env.VECTOR_SEARCH_MIN_SIMILARITY, DEFAULT_MIN_SIMILARITY);
}

function getMaxContextChars() {
  return Math.floor(
    readPositiveNumber(process.env.VECTOR_SEARCH_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS),
  );
}

function explicitTitleFromQuery(searchQuery: string) {
  const bracket = searchQuery.match(/\[([^\]]+)\]/);
  if (bracket?.[1] && bracket[1].trim().length >= 3) return bracket[1].trim();

  for (const line of searchQuery.split("\n")) {
    const bullet = line.match(/^-\s+(.+)/);
    if (!bullet) continue;
    const text = bullet[1].trim();
    if (text.startsWith("Current question:")) continue;
    if (/\b(link|url|notion)\b/i.test(text) && text.length < 80) continue;
    const head = text
      .replace(
        /^(what is|what's|summarize|summary of|explain|describe|tell me about|can i get|give me)\s+/i,
        "",
      )
      .split(/[—–:-]/)[0]
      ?.trim();
    if (head && head.length >= 8) return head;
  }

  return null;
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
    .replace(
      /^(?:can you\s+)?(summarize|summary of|explain|describe|what is|what's|tell me about|provide me with|provide|give me|give all data of|give data of|show me|show)\s+/i,
      "",
    )
    .replace(/\b(what is|what's|core idea|main idea|summary|explain|provide|details?)\b.*$/i, "")
    .trim();

  return Array.from(new Set([splitCandidates[0], questionRemoved, normalized].filter(Boolean))).slice(0, 3);
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

  const explicitTitle = explicitTitleFromQuery(cleaned);
  const titleRows = explicitTitle
    ? mergeSearchRows(await titleSearch(explicitTitle), await titleSearch(cleaned))
    : await titleSearch(cleaned);

  if (await hasNotionChunks()) {
    const chunkPart = await hybridChunkContext(cleaned);
    if (chunkPart) {
      const titlePart = titleRows.length ? `${formatContext(titleRows)}\n\n---\n\n` : "";
      return `${titlePart}${chunkPart}`;
    }
  }

  let rows: SearchRow[] = [];
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
