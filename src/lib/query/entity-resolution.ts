import { likePattern, query } from "@/lib/db";
import type { ParsedQuery } from "./types";

/**
 * Map an ambiguous topic ("Oscar") to the best-matching synced page title before SQL/RAG.
 */
export async function canonicalizeDocTitle(topic: string): Promise<string> {
  const trimmed = topic.trim();
  if (trimmed.length < 2) return trimmed;

  const exact = await query<{ title: string | null }>(
    `
    SELECT title FROM notion_pages
    WHERE lower(trim(coalesce(title, ''))) = lower(trim($1))
    LIMIT 1
    `,
    [trimmed],
  );
  if (exact[0]?.title) return exact[0].title;

  const term = likePattern(trimmed);
  const candidates = await query<{ title: string | null; score: number }>(
    `
    SELECT title,
      CASE
        WHEN lower(trim(coalesce(title, ''))) = lower(trim($2)) THEN 1000
        WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 500 + length(coalesce(title, ''))
        ELSE 10
      END AS score
    FROM notion_pages
    WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
    ORDER BY score DESC, length(coalesce(title, '')) ASC
    LIMIT 5
    `,
    [term, trimmed],
  );

  const best = candidates[0];
  if (!best?.title) return trimmed;
  if (best.score >= 500 || candidates.length === 1) return best.title;
  return trimmed;
}

/** Resolve docTitle / compareTitleB on a parsed query when present. */
export async function resolveEntities(parsed: ParsedQuery): Promise<ParsedQuery> {
  let docTitle = parsed.docTitle;
  let compareTitleB = parsed.compareTitleB;

  if (docTitle?.trim()) {
    docTitle = await canonicalizeDocTitle(docTitle);
  }
  if (compareTitleB?.trim()) {
    compareTitleB = await canonicalizeDocTitle(compareTitleB);
  }

  if (docTitle === parsed.docTitle && compareTitleB === parsed.compareTitleB) {
    return parsed;
  }

  return { ...parsed, docTitle, compareTitleB };
}
