import {
  containsAnyPhrase,
  containsPhrase,
  splitWords,
  toLower,
} from "@/lib/shared/text-utils";
import { extractYear } from "./year";

export function extractYearFromQuestion(question: string): number | undefined {
  const explicitYear = extractYear(question);
  if (explicitYear !== null) return explicitYear;

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

const NOISE_WORDS = new Set([
  // Question / Relative
  "which", "what", "who", "whom", "whose", "where", "when", "why", "how",
  // Verbs / Auxiliaries
  "did", "does", "do", "has", "have", "had", "is", "are", "was", "were", "be", "been", "can", "could", "will", "would", "should",
  // Articles / Determiners / Pronouns
  "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her", "their", "our", "me", "i", "you", "he", "she", "it", "we", "they", "him", "them", "us",
  // Quantifiers
  "all", "every", "each", "some", "any", "no", "none", "only", "one",
  // Prepositions / Conjunctions
  "for", "in", "on", "at", "by", "with", "about", "to", "from", "of", "and", "or", "but", "as", "than",
  // Instructions / Actions
  "list", "show", "give", "find", "get", "tell", "display", "check", "verify", "search", "lookup", "down",
  // Time references
  "today", "tonight", "tomorrow", "yesterday", "week", "month", "year", "now", "currently", "lately", "recent", "recently"
]);

export function isNoiseTopic(topic?: string): boolean {
  if (!topic?.trim()) return true;
  const normalized = topic.trim().toLowerCase();
  
  // Direct check for exact phrase or single word match
  if (NOISE_WORDS.has(normalized)) return true;
  
  // Common multi-word noise phrases
  const noisePhrases = [
    "list down",
    "give me",
    "tell me",
    "today or this week",
    "today or next week",
    "this week",
    "next week",
    "last week",
    "this month",
    "next month",
    "last month",
    "this year",
    "next year",
    "last year"
  ];
  if (noisePhrases.includes(normalized)) return true;

  // If every word in the topic is a noise word or if it consists only of noise words
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.every(word => NOISE_WORDS.has(word))) {
    return true;
  }

  return false;
}

export function isWorkspaceScope(scope?: string): boolean {
  if (!scope?.trim()) return true;
  const t = scope.toLowerCase().trim();
  if (/\b(workspace|navgurukul|ng|ng-navgurukul)\b/.test(t) && t.length < 40) return true;
  return isNoiseTopic(scope);
}
