export function extractYearFromQuestion(question: string): number | undefined {
  const match = question.match(/\b(20\d{2})\b/);
  if (!match?.[1]) return undefined;
  const year = Number.parseInt(match[1], 10);
  return year >= 2020 && year <= 2099 ? year : undefined;
}

/** Remove trailing "in (year) 2025" from a captured person name. */
export function stripYearSuffixFromPerson(value: string): string {
  return value
    .replace(/\s+in\s+(?:the\s+)?(?:year\s+)?(20\d{2})\s*$/i, "")
    .replace(/\s+(?:for|during)\s+(?:the\s+)?(?:year\s+)?(20\d{2})\s*$/i, "")
    .trim();
}

const CROSS_DOC_NOISE = /^(?:main|the|themes?|all|across|related|docs?|documents?|pages?)$/i;

/** Project/product name from "Zuvy-related docs", "themes across all Oscar pages", etc. */
export function extractCrossDocSummaryTopic(question: string): string | undefined {
  const q = question.trim();

  const relatedMatch = q.match(/\b([A-Za-z][\w'-]{1,40})-related\s+(?:docs?|documents?|pages?)\b/i);
  if (relatedMatch?.[1] && !CROSS_DOC_NOISE.test(relatedMatch[1])) {
    return relatedMatch[1].trim();
  }

  const acrossMatch = q.match(
    /\bacross\s+all\s+(?:the\s+)?([A-Za-z][\w'-]{1,40})(?:-related)?\s+(?:docs?|documents?|pages?)\b/i,
  );
  if (acrossMatch?.[1] && !CROSS_DOC_NOISE.test(acrossMatch[1])) {
    return acrossMatch[1].trim();
  }

  const themesMatch = q.match(
    /\b(?:main\s+)?themes?\s+across\s+(?:all\s+)?(?:the\s+)?([A-Za-z][\w'-]{1,40})(?:-related)?(?:\s+(?:docs?|documents?|pages?))?\b/i,
  );
  if (themesMatch?.[1] && !CROSS_DOC_NOISE.test(themesMatch[1])) {
    return themesMatch[1].trim();
  }

  return undefined;
}

export function isCrossDocSummaryQuestion(question: string): boolean {
  if (extractCrossDocSummaryTopic(question)) return true;
  const q = question.toLowerCase();
  return (
    (/\b(across\s+all|main\s+themes|themes\s+across|all\s+.+\s+related)\b/.test(q) ||
      /\b.related\s+(?:docs?|documents?|pages?)\b/.test(q)) &&
    /\b(summarize|summary|summarise|themes?|overview)\b/.test(q)
  );
}

/** Reject phrase-like captures that are not a single Notion page title (not a strict length cap). */
export function looksLikeSinglePageTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 4) return false;
  // Real Notion titles can be long; only block absurdly long captures (runaway regex).
  if (t.split(/\s+/).length > 45 || t.length > 280) return false;
  if (/\b(across\s+all|main\s+themes|related\s+docs?|all\s+.+\s+related)\b/i.test(t)) {
    return false;
  }
  return true;
}
