/**
 * Build text context for the chat LLM: keyword page prefetch + chunk/vector search.
 */
import { escapeLike, query } from "@/lib/db";
import { extractQuestionTerms } from "@/lib/rag/question-terms";
import { simplifySearchQuery } from "@/lib/shared/search-query";
import { runHybridChunkRetrieval } from "@/lib/rag/hybrid-search";
import {
  assessRetrievalConfidence,
  type ChunkRetrievalHit,
  type RetrievalConfidenceResult,
} from "@/lib/rag/retrieval-confidence";
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

const PROPERTIES_MARKER = "=== PROPERTIES ===";
const CONTENT_MARKER = "=== CONTENT ===";

function stripNotionBodyMarkers(raw: string) {
  let body = raw;

  if (body.includes(PROPERTIES_MARKER) && body.includes(CONTENT_MARKER)) {
    const contentIndex = body.indexOf(CONTENT_MARKER);
    body = body.slice(contentIndex + CONTENT_MARKER.length);
  }

  return body.split(PROPERTIES_MARKER).join("").split(CONTENT_MARKER).join("").trim();
}

function formatPageSection(row: PageRow) {
  const title = row.title || "Untitled";
  const body = stripNotionBodyMarkers(row.content || "");
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

function assembleChatContext(prefetch: string, semantic: string) {
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

export type ChatContextBuild = {
  context: string;
  confidence: RetrievalConfidenceResult;
  chunkHits: ChunkRetrievalHit[];
};

/**
 * Unified context for the LLM with retrieval confidence (evidence gate).
 */
export async function buildNotionContextForChat(
  searchQuery: string | string[],
): Promise<string> {
  const built = await buildNotionContextWithConfidence(searchQuery);
  return built.context;
}

export async function buildNotionContextWithConfidence(
  searchQuery: string | string[],
  options?: { titleBoost?: string },
): Promise<ChatContextBuild> {
  const queries = Array.isArray(searchQuery) ? searchQuery : [searchQuery];
  const primary = queries.find((q) => q.trim())?.trim() ?? "";
  const titleBoost = options?.titleBoost?.trim();

  const [prefetch, hybrid] = await Promise.all([
    prefetchPagesFromQuestion(titleBoost || primary),
    runHybridChunkRetrieval(queries, titleBoost),
  ]);

  let semantic = hybrid.context ?? "";
  if (!semantic) {
    semantic = await semanticSearch(queries.length > 1 ? queries : primary, {
      skipHybrid: true,
    });
  }

  const context = assembleChatContext(prefetch, semantic);
  const chunkHits: ChunkRetrievalHit[] = hybrid.rows.map((row) => ({
    chunk_id: row.chunk_id,
    page_id: row.page_id,
    title: row.title,
    final_score: row.final_score,
    sem_score: row.sem_score,
    kw_score: row.kw_score,
  }));

  const confidence = assessRetrievalConfidence(chunkHits, prefetch.length);

  return { context, confidence, chunkHits };
}
