import { likePattern, query } from "@/lib/db";
import type { ParsedQuery } from "./types";
import {
  pickBestTitleMatch,
  scoreTitleForTopic,
  shouldKeepOriginalTopic,
} from "./topic-resolution";
import { isWorkspaceScope } from "./normalize";

/**
 * Map an ambiguous topic ("Oscar", "Stub") to the best-matching synced page title.
 * Prefers short hub titles over long migration/bug tickets that substring-match.
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
  const candidates = await query<{ title: string | null }>(
    `
    SELECT title
    FROM notion_pages
    WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
    ORDER BY length(coalesce(title, '')) ASC
    LIMIT 40
    `,
    [term],
  );

  const best = pickBestTitleMatch(trimmed, candidates);
  if (!best?.title) return trimmed;

  const bestScore = scoreTitleForTopic(trimmed, best.title);
  if (bestScore < 400 && trimmed.length <= 16) {
    return trimmed;
  }

  if (shouldKeepOriginalTopic(trimmed, best.title)) return trimmed;
  return best.title;
}

/** Resolve docTitle / compareTitleB on a parsed query when present. */
export async function resolveEntities(parsed: ParsedQuery): Promise<ParsedQuery> {
  let docTitle = parsed.docTitle;
  let compareTitleB = parsed.compareTitleB;

  if (docTitle?.trim()) {
    const original = docTitle.trim();
    if (isWorkspaceScope(original)) {
      docTitle = original;
    } else {
      docTitle = await canonicalizeDocTitle(original);
      if (shouldKeepOriginalTopic(original, docTitle)) {
        docTitle = original;
      }
    }
  }
  if (compareTitleB?.trim()) {
    const original = compareTitleB.trim();
    if (isWorkspaceScope(original)) {
      compareTitleB = original;
    } else {
      compareTitleB = await canonicalizeDocTitle(original);
      if (shouldKeepOriginalTopic(original, compareTitleB)) {
        compareTitleB = original;
      }
    }
  }

  if (docTitle === parsed.docTitle && compareTitleB === parsed.compareTitleB) {
    return parsed;
  }

  return { ...parsed, docTitle, compareTitleB };
}
