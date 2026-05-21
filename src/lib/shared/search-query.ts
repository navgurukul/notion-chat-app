/** Shared query cleanup for full-text and hybrid search. */
export function simplifySearchQuery(searchQuery: string) {
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
    "with",
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
