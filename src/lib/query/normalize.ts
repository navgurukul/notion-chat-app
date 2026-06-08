import {
  containsAnyPhrase,
  containsPhrase,
  extractYear,
  splitWords,
  toLower,
} from "@/lib/shared/text-utils";

export function extractYearFromQuestion(question: string): number | undefined {
  const explicitYear = extractYear(question);
  if (explicitYear) return explicitYear;

  const currentYear = new Date().getFullYear();
  const lower = question.toLowerCase();

  if (/\b(this|current|present) year\b/.test(lower)) return currentYear;
  if (/\blast year\b/.test(lower)) return currentYear - 1;
  if (/\bnext year\b/.test(lower)) return currentYear + 1;

  return undefined;
}

const YEAR_SUFFIX_TRIGGERS = [" in ", " for ", " during "];

/** Remove trailing "in 2025" / "for the year 2025" from a captured person name. */
/** Strip common honorifics ("amruta ji" → "amruta") for owner/assignee SQL matching. */
export function normalizePersonNameForMatch(name: string) {
  return name
    .trim()
    .replace(/\s+(?:ji|jee|ji\.|sir|ma'?am|ben|bhai|didi|madam)\s*$/i, "")
    .trim();
}

export function stripYearSuffixFromPerson(value: string) {
  let text = value.trim();

  for (const trigger of YEAR_SUFFIX_TRIGGERS) {
    const lower = toLower(text);
    const index = lower.lastIndexOf(trigger);
    if (index === -1) continue;

    const tail = text.slice(index + trigger.length).trim();
    const tailWords = splitWords(tail);

    if (tailWords[0]?.toLowerCase() === "the") tailWords.shift();
    if (tailWords[0]?.toLowerCase() === "year") tailWords.shift();

    const yearWord = tailWords[0];
    const year = yearWord ? Number.parseInt(yearWord, 10) : NaN;

    if (year >= 2020 && year <= 2099) {
      text = text.slice(0, index).trim();
    }
  }

  return text;
}

const CROSS_DOC_NOISE = new Set([
  "main",
  "the",
  "theme",
  "themes",
  "all",
  "across",
  "related",
  "doc",
  "docs",
  "document",
  "documents",
  "page",
  "pages",
]);

function isCrossDocNoiseWord(word: string) {
  return CROSS_DOC_NOISE.has(toLower(word));
}

function wordBeforePhrase(text: string, phrase: string) {
  const lower = toLower(text);
  const index = lower.indexOf(toLower(phrase));
  if (index === -1) return null;

  const before = text.slice(0, index).trim();
  const words = splitWords(before);
  if (!words.length) return null;

  let candidate = words[words.length - 1];
  if (candidate.endsWith("-related")) {
    candidate = candidate.slice(0, "-related".length);
  }

  if (!candidate || isCrossDocNoiseWord(candidate)) return null;
  return candidate.trim();
}

/** Project/product name from "Zuvy-related docs", "themes across all Oscar pages", etc. */
export function extractCrossDocSummaryTopic(question: string): string | undefined {
  const q = question.trim();

  const fromRelated = wordBeforePhrase(q, "-related docs") ?? wordBeforePhrase(q, "-related documents");
  if (fromRelated) return fromRelated;

  const fromAcross = wordBeforePhrase(q, " across all ");
  if (fromAcross && containsPhrase(q, "doc")) return fromAcross;

  if (containsPhrase(q, "themes across")) {
    const topic = wordBeforePhrase(q, " themes across ");
    if (topic) return topic;
  }

  return undefined;
}

export function isCrossDocSummaryQuestion(question: string): boolean {
  if (extractCrossDocSummaryTopic(question)) return true;

  const q = toLower(question);
  const hasCrossDocPhrase = containsAnyPhrase(q, [
    "across all",
    "main themes",
    "themes across",
    "related docs",
    "related documents",
    "related pages",
  ]);

  const hasSummaryPhrase = containsAnyPhrase(q, [
    "summarize",
    "summary",
    "summarise",
    "theme",
    "themes",
    "overview",
  ]);

  return hasCrossDocPhrase && hasSummaryPhrase;
}

/** Reject phrase-like captures that are not a single Notion page title. */
export function looksLikeSinglePageTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 4) return false;
  if (splitWords(t).length > 45 || t.length > 280) return false;

  const lower = toLower(t);
  if (containsPhrase(lower, "across all")) return false;
  if (containsPhrase(lower, "main themes")) return false;
  if (containsPhrase(lower, "related doc")) return false;

  return true;
}
