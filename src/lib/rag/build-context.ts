/**
 * Build text context for the chat LLM: keyword page prefetch + chunk/vector search.
 */
import { escapeLike, query } from "@/lib/db";
import { simplifySearchQuery } from "@/lib/shared/search-query";
import {
  assessRetrievalConfidence,
  extractQuestionTerms,
  runHybridChunkRetrieval,
  semanticSearch,
  type ChunkRetrievalHit,
  type RetrievalConfidenceResult,
} from "@/lib/rag";

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

// Result of the keyword prefetch stage: the assembled text for the prompt,
// plus how many distinct pages actually matched. Keeping `count` separate
// from `text` matters because `text.length` is a character count, not a hit
// count — passing the former into confidence scoring silently produced
// wildly inflated "evidence" numbers (a single short page could easily be
// 1000+ characters).
type PrefetchResult = {
  text: string;
  count: number;
};

const PREFETCH_LIMIT = 12;
const BODY_SNIPPET_CHARS = 1200;

const PROPERTIES_MARKER = "=== PROPERTIES ===";
const CONTENT_MARKER = "=== CONTENT ===";

// Suffixes to strip when doing fuzzy core-term fallback.
// e.g. "DataPivot AI" → "DataPivot", "Zuvy App" → "Zuvy"
const FUZZY_STRIP_SUFFIX =
  /\s+(ai|app|platform|project|tool|system|service|v\d+(\.\d+)*|mvp|beta|poc)$/i;

function stripNotionBodyMarkers(raw: string) {
  let body = raw;

  if (body.includes(PROPERTIES_MARKER) && body.includes(CONTENT_MARKER)) {
    const contentIndex = body.indexOf(CONTENT_MARKER);
    body = body.slice(contentIndex + CONTENT_MARKER.length);
  }

  return body.split(PROPERTIES_MARKER).join("").split(CONTENT_MARKER).join("").trim();
}

function yearWindow(year?: number) {
  if (!year) return null;
  return {
    start: `${year}-01-01`,
    end: `${year + 1}-01-01`,
  };
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

/**
 * Derive a shorter "core term" from a query by stripping common product/project
 * suffixes. Returns null if nothing was stripped (no point retrying).
 *
 * Examples:
 *   "DataPivot AI"   → "datapivot"
 *   "Zuvy App"       → "zuvy"
 *   "Oscar MVP"      → "oscar"
 *   "ReportList"     → null  (nothing to strip)
 */
function deriveCoreTerm(term: string): string | null {
  const stripped = term.trim().replace(FUZZY_STRIP_SUFFIX, "").trim().toLowerCase();
  if (stripped === term.trim().toLowerCase()) return null; // nothing changed
  if (stripped.length < 4) return null; // too short — substring LIKE gets noisy below this
  return stripped;
}

/** Always fetch real rows from notion_pages — works without chunk embeddings. */
export async function prefetchPagesFromQuestion(
  question: string,
  year?: number,
): Promise<PrefetchResult> {
  const cleaned = simplifySearchQuery(question);
  const terms = extractQuestionTerms(question);
  if (!cleaned && !terms.length) return { text: "", count: 0 };
  const bounds = yearWindow(year);

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
    const likeRows = bounds
      ? await query<PageRow>(
          `
          SELECT id, title, url, owner, created_by, status, doc_type, content,
            (
              CASE WHEN lower(coalesce(title, '')) = $2 THEN 100 ELSE 0 END +
              CASE WHEN lower(coalesce(title, '')) LIKE $3 ESCAPE '\\' THEN 50 ELSE 0 END +
              (
                SELECT count(*)::int FROM unnest($1::text[]) AS pat(p)
                WHERE lower(coalesce(title, '')) LIKE pat.p
              ) * 8
            ) AS rank
          FROM notion_pages
          WHERE
            lower(coalesce(title, '')) LIKE ANY($1::text[])
            AND notion_edited_at >= $5::timestamptz
            AND notion_edited_at < $6::timestamptz
          ORDER BY rank DESC, length(coalesce(title, '')) ASC, title ASC
          LIMIT $4
          `,
          [likePatterns, primaryTerm, `%${escapeLike(primaryTerm)}%`, PREFETCH_LIMIT, bounds.start, bounds.end],
        )
      : await query<PageRow>(
          `
          SELECT id, title, url, owner, created_by, status, doc_type, content,
            (
              CASE WHEN lower(coalesce(title, '')) = $2 THEN 100 ELSE 0 END +
              CASE WHEN lower(coalesce(title, '')) LIKE $3 ESCAPE '\\' THEN 50 ELSE 0 END +
              (
                SELECT count(*)::int FROM unnest($1::text[]) AS pat(p)
                WHERE lower(coalesce(title, '')) LIKE pat.p
              ) * 8
            ) AS rank
          FROM notion_pages
          WHERE
            lower(coalesce(title, '')) LIKE ANY($1::text[])
          ORDER BY rank DESC, length(coalesce(title, '')) ASC, title ASC
          LIMIT $4
          `,
          [likePatterns, primaryTerm, `%${escapeLike(primaryTerm)}%`, PREFETCH_LIMIT],
        );
    pushRows(likeRows);
  }

  // ── Fuzzy core-term fallback ──────────────────────────────────────────────
  // If the primary term matched nothing (e.g. "DataPivot AI" isn't an exact
  // page title), strip known product suffixes and retry with just the core
  // name (e.g. "datapivot"). This surfaces pages like "DataPivot Sprint 3"
  // or "DataPivot — Q4 Review" that contain the project name but not the
  // full compound title the user typed.
  if (!merged.length && terms.length > 0) {
    const coreTerm = deriveCoreTerm(terms[0]);
    if (coreTerm) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[prefetch] fuzzy_core_term_fallback", {
          original: terms[0],
          coreTerm,
        });
      }
      const fuzzyRows = await query<PageRow>(
        bounds
          ? `
            SELECT id, title, url, owner, created_by, status, doc_type, content,
              (
                CASE WHEN lower(coalesce(title, '')) LIKE $1 ESCAPE '\\' THEN 60 ELSE 0 END
              ) AS rank
            FROM notion_pages
            WHERE
              lower(coalesce(title, '')) LIKE $1 ESCAPE '\\'
              AND notion_edited_at >= $2::timestamptz
              AND notion_edited_at < $3::timestamptz
            ORDER BY rank DESC, length(coalesce(title, '')) ASC, title ASC
            LIMIT $4
            `
          : `
            SELECT id, title, url, owner, created_by, status, doc_type, content,
              (
                CASE WHEN lower(coalesce(title, '')) LIKE $1 ESCAPE '\\' THEN 60 ELSE 0 END
              ) AS rank
            FROM notion_pages
            WHERE
              lower(coalesce(title, '')) LIKE $1 ESCAPE '\\'
            ORDER BY rank DESC, length(coalesce(title, '')) ASC, title ASC
            LIMIT $2
            `,
        bounds ? [`%${escapeLike(coreTerm)}%`, bounds.start, bounds.end, PREFETCH_LIMIT] : [`%${escapeLike(coreTerm)}%`, PREFETCH_LIMIT],
      );
      pushRows(fuzzyRows);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (merged.length < PREFETCH_LIMIT && cleaned.length >= 2) {
    try {
      const ftsRows = bounds
        ? await query<PageRow>(
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
                2 * ts_rank(
                  to_tsvector('english', coalesce(title, '')),
                  plainto_tsquery('english', $1)
                )
              ) AS rank
            FROM notion_pages
            WHERE to_tsvector('english', coalesce(title, ''))
              @@ plainto_tsquery('english', $1)
              AND notion_edited_at >= $2::timestamptz
              AND notion_edited_at < $3::timestamptz
            ORDER BY rank DESC, notion_edited_at DESC NULLS LAST
            LIMIT $4
            `,
            [cleaned, bounds.start, bounds.end, PREFETCH_LIMIT],
          )
        : await query<PageRow>(
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
                2 * ts_rank(
                  to_tsvector('english', coalesce(title, '')),
                  plainto_tsquery('english', $1)
                )
              ) AS rank
            FROM notion_pages
            WHERE to_tsvector('english', coalesce(title, ''))
              @@ plainto_tsquery('english', $1)
            ORDER BY rank DESC, notion_edited_at DESC NULLS LAST
            LIMIT $2
            `,
            [cleaned, PREFETCH_LIMIT],
          );
      pushRows(ftsRows);
    } catch {
      // plainto_tsquery can fail on odd input; LIKE results above are enough
    }
  }

  if (!merged.length) return { text: "", count: 0 };

  const sections = merged.map((row) => formatPageSection(row));
  return { text: sections.join("\n\n---\n\n"), count: merged.length };
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

function extractPrefetchSections(context: string) {
  const prefetchBlock = context
    .split("\n\n---\n\n## Additional excerpts (search index)")[0]
    .trim();
  const prefetchSection = prefetchBlock
    .replace(/^## Synced Notion pages \(from database\)\n\n/, "")
    .trim();

  if (!prefetchSection) return [];

  return prefetchSection
    .split("\n\n---\n\n")
    .map((section) => section.trim())
    .filter(Boolean);
}

function formatRetrievalPreviewSection(section: string) {
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const title = lines.find((line) => line.startsWith("Title:")) ?? "Title: Untitled";
  const url = lines.find((line) => line.startsWith("URL:"));
  const status = lines.find((line) => line.startsWith("Status:"));
  const owner = lines.find((line) => line.startsWith("Owner:"));
  const metadata = [status, owner].filter(Boolean).join(" · ");
  const snippet = lines
    .filter((line) => !/^(Title|URL|Status|Owner|Created by|Type):/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const clippedSnippet = snippet.length > 320 ? `${snippet.slice(0, 320)}...` : snippet;

  return [title, metadata, url, clippedSnippet ? `Snippet: ${clippedSnippet}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function buildRetrievalOnlyAnswer(context: string) {
  const previewSections = extractPrefetchSections(context).slice(0, 3);

  if (!previewSections.length) {
    return "I found related Notion pages, but I couldn't build a compact preview. Try rephrasing with a page, project, or person name from Notion.";
  }

  const preview = previewSections.map((section) => formatRetrievalPreviewSection(section)).join(
    "\n\n",
  );

  return [
    "I found related Notion pages, but I'm returning the strongest matches without generating a full AI answer to stay within the AI budget.",
    "",
    preview,
  ].join("\n");
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
  options?: { titleBoost?: string; year?: number; loosenThreshold?: boolean },
): Promise<ChatContextBuild> {
  const queries = Array.isArray(searchQuery) ? searchQuery : [searchQuery];
  const primary = queries.find((q) => q.trim())?.trim() ?? "";
  const titleBoost = options?.titleBoost?.trim();
  const year = options?.year;

  const [prefetchResult, hybrid] = await Promise.all([
    prefetchPagesFromQuestion(titleBoost || primary, year),
    runHybridChunkRetrieval(queries, titleBoost, { year }),
  ]);
  const { text: prefetch, count: prefetchCount } = prefetchResult;

  let semantic = hybrid.context ?? "";
  if (!semantic) {
    semantic = await semanticSearch(queries.length > 1 ? queries : primary, {
      skipHybrid: true,
      year,
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

  // Fixed: pass the actual number of prefetched pages, not prefetch.length
  // (which was the character count of the joined prefetch text — often in
  // the thousands — silently distorting whatever weight this was meant to
  // carry in the confidence calculation).
  const confidence = assessRetrievalConfidence(chunkHits, prefetchCount, options?.loosenThreshold);

  return { context, confidence, chunkHits };
}