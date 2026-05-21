/**
 * Build text context for Gemini: keyword page prefetch + chunk/vector search.
 */
import { escapeLike, query } from "@/lib/db";
import { extractCrossDocSummaryTopic } from "@/lib/query/normalize";
import { simplifySearchQuery } from "@/lib/shared/search-query";
import { semanticSearch } from "@/lib/rag/semantic-search";

type PageRow = {
  id: string;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  status: string | null;
  doc_type: string | null;
  content: string | null;
  rank?: number;
};

const PREFETCH_LIMIT = 12;
const BODY_SNIPPET_CHARS = 1200;

/** Pull meaningful tokens from a natural-language question. */
export function extractQuestionTerms(question: string) {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "about",
    "any",
    "can",
    "could",
    "current",
    "do",
    "does",
    "for",
    "from",
    "give",
    "how",
    "in",
    "is",
    "it",
    "me",
    "of",
    "on",
    "or",
    "please",
    "progress",
    "show",
    "status",
    "summarize",
    "summary",
    "tell",
    "the",
    "this",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "you",
    "your",
  ]);

  const tokens = question
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-zA-Z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stop.has(t.toLowerCase()));

  const phrases: string[] = [];
  const progressMatch = question.match(
    /(?:progress|status)\s+on\s+(?:the\s+(?:project\s+)?)?([a-zA-Z0-9][\w\s'-]{1,40})/i,
  );
  if (progressMatch?.[1]) phrases.push(progressMatch[1].trim());

  const aboutMatch = question.match(
    /(?:tell me about|about|regarding)\s+(?:the\s+)?([a-zA-Z0-9][\w\s'-]{2,60})/i,
  );
  if (aboutMatch?.[1]) phrases.push(aboutMatch[1].trim());

  const crossDocTopic = extractCrossDocSummaryTopic(question);
  if (crossDocTopic) phrases.unshift(crossDocTopic);

  const moduleMatch = question.match(
    /\b(?:for\s+)?(?:the\s+)?([a-zA-Z][\w\s'-]{2,40}?)\s+module\b/i,
  );
  if (moduleMatch?.[1]) {
    const phrase = moduleMatch[1].replace(/^(?:this|that)\s+/i, "").trim();
    if (phrase.length >= 3) {
      phrases.push(phrase);
      phrases.push(`${phrase} module`);
    }
  }

  const paymentsMatch = question.match(/\bpayments?\b/i);
  if (paymentsMatch) phrases.push("payment", "payments", "PRD");

  const whyTopicMatch = question.match(
    /\b(?:why|how)\b.+\b(?:for|in|on)\s+(?:the\s+)?([a-zA-Z][\w\s'-]{2,40})\b/i,
  );
  if (whyTopicMatch?.[1]) phrases.push(whyTopicMatch[1].trim());

  return Array.from(new Set([...phrases, ...tokens])).slice(0, 8);
}

function formatPageSection(row: PageRow) {
  const title = row.title || "Untitled";
  const body = (row.content || "")
    .replace(/=== PROPERTIES ===[\s\S]*?=== CONTENT ===/g, "")
    .replace(/=== PROPERTIES ===|=== CONTENT ===/g, "")
    .trim();
  const snippet =
    body.length > BODY_SNIPPET_CHARS ? `${body.slice(0, BODY_SNIPPET_CHARS)}...` : body;

  return [
    `Title: ${title}`,
    row.url ? `URL: ${row.url}` : "",
    row.status ? `Status: ${row.status}` : "",
    row.owner ? `Owner: ${row.owner}` : "",
    row.created_by ? `Created by: ${row.created_by}` : "",
    row.doc_type ? `Type: ${row.doc_type}` : "",
    snippet ? `\n${snippet}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Always fetch real rows from notion_pages — works without chunk embeddings. */
export async function prefetchPagesFromQuestion(question: string): Promise<string> {
  const cleaned = simplifySearchQuery(question);
  const terms = extractQuestionTerms(question);
  if (!cleaned && !terms.length) return "";

  const seen = new Set<string>();
  const merged: PageRow[] = [];

  const pushRows = (rows: PageRow[]) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
      if (merged.length >= PREFETCH_LIMIT) return;
    }
  };

  if (terms.length > 0) {
    const likePatterns = terms.map((t) => `%${escapeLike(t.toLowerCase())}%`);
    const primaryTerm = terms[0].toLowerCase();
    const likeRows = await query<PageRow>(
      `
      SELECT id, title, url, owner, created_by, status, doc_type, content,
        (
          CASE WHEN lower(coalesce(title, '')) = $2 THEN 100 ELSE 0 END +
          CASE WHEN lower(coalesce(title, '')) LIKE $3 ESCAPE '\\' THEN 50 ELSE 0 END +
          (
            SELECT count(*)::int FROM unnest($1::text[]) AS pat(p)
            WHERE lower(coalesce(title, '')) LIKE pat.p
               OR lower(coalesce(content, '')) LIKE pat.p
          ) * 8
        ) AS rank
      FROM notion_pages
      WHERE
        lower(coalesce(title, '')) LIKE ANY($1::text[])
        OR lower(coalesce(content, '')) LIKE ANY($1::text[])
      ORDER BY rank DESC, length(coalesce(title, '')) ASC, title ASC
      LIMIT $4
      `,
      [likePatterns, primaryTerm, `%${escapeLike(primaryTerm)}%`, PREFETCH_LIMIT],
    );
    pushRows(likeRows);
  }

  if (merged.length < PREFETCH_LIMIT && cleaned.length >= 2) {
    try {
      const ftsRows = await query<PageRow>(
        `
        SELECT
          id,
          title,
          url,
          owner,
          created_by,
          status,
          doc_type,
          content,
          (
            ts_rank(
              to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')),
              plainto_tsquery('english', $1)
            ) +
            2 * ts_rank(
              to_tsvector('english', coalesce(title, '')),
              plainto_tsquery('english', $1)
            )
          ) AS rank
        FROM notion_pages
        WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
          @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2
        `,
        [cleaned, PREFETCH_LIMIT],
      );
      pushRows(ftsRows);
    } catch {
      // plainto_tsquery can fail on odd input; LIKE results above are enough
    }
  }

  if (!merged.length) return "";

  const sections = merged.map((row) => formatPageSection(row));
  return sections.join("\n\n---\n\n");
}

/**
 * Unified context for the LLM: database pages first, then chunk/vector search.
 * Ensures answers can use real synced Notion data even when embeddings are sparse.
 */
export async function buildNotionContextForChat(searchQuery: string): Promise<string> {
  const [prefetch, semantic] = await Promise.all([
    prefetchPagesFromQuestion(searchQuery),
    semanticSearch(searchQuery),
  ]);

  if (!prefetch && !semantic) return "";
  if (!prefetch) return semantic;
  if (!semantic) {
    return `## Synced Notion pages (from database)\n\n${prefetch}`;
  }

  return [
    "## Synced Notion pages (from database)",
    prefetch,
    "---",
    "## Additional excerpts (search index)",
    semantic,
  ].join("\n\n");
}
