import { keepLettersNumbersAndSpaces, splitWords, toLower } from "@/lib/shared/text-utils";

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

  const keywords = splitWords(keepLettersNumbersAndSpaces(toLower(searchQuery))).filter(
    (word) => word.length > 1 && !stopWords.has(word),
  );

  return keywords.join(" ").trim() || searchQuery.trim();
}
