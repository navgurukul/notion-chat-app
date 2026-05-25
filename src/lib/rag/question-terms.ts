/**
 * Pull search terms from a user question — readable phrase rules, no regex.
 */
import { extractCrossDocSummaryTopic } from "@/lib/query/normalize";
import {
  containsPhrase,
  extractAfterPhrase,
  keepLettersNumbersAndSpaces,
  splitWords,
  toLower,
} from "@/lib/shared/text-utils";

const STOP_WORDS = new Set([
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

function normalizeQuestionWords(question: string) {
  const cleaned = question
    .split("“")
    .join('"')
    .split("”")
    .join('"')
    .split("‘")
    .join("'")
    .split("’")
    .join("'");

  return splitWords(keepLettersNumbersAndSpaces(cleaned));
}

function extractTopicPhrases(question: string) {
  const phrases: string[] = [];

  const progress = extractAfterPhrase(question, ["progress on", "status on"], {
    maxLength: 40,
    skipLeadingWords: ["the", "a", "project"],
  });
  if (progress) phrases.push(progress);

  const about = extractAfterPhrase(
    question,
    ["tell me about", "about", "regarding"],
    { maxLength: 60, skipLeadingWords: ["the", "a"] },
  );
  if (about) phrases.push(about);

  const crossDocTopic = extractCrossDocSummaryTopic(question);
  if (crossDocTopic) phrases.unshift(crossDocTopic);

  const lower = toLower(question);
  if (containsPhrase(lower, " module")) {
    const moduleIndex = lower.lastIndexOf(" module");
    const beforeModule = question.slice(0, moduleIndex).trim();
    const words = splitWords(beforeModule);
    if (words.length >= 1) {
      const nameWords = words.slice(-6);
      let phrase = nameWords.join(" ").trim();
      if (startsWithThisOrThat(phrase)) {
        phrase = splitWords(phrase).slice(1).join(" ");
      }
      if (phrase.length >= 3) {
        phrases.push(phrase);
        phrases.push(`${phrase} module`);
      }
    }
  }

  if (containsPhrase(lower, "payment")) {
    phrases.push("payment", "payments", "PRD");
  }

  const whyHowTopic = extractWhyOrHowTopic(question);
  if (whyHowTopic) phrases.push(whyHowTopic);

  return phrases;
}

function startsWithThisOrThat(text: string) {
  const lower = toLower(text);
  return lower.startsWith("this ") || lower.startsWith("that ");
}

function extractWhyOrHowTopic(question: string) {
  const lower = toLower(question);
  if (!lower.includes("why") && !lower.includes("how")) return null;

  const triggers = [" for ", " in ", " on "];
  for (const trigger of triggers) {
    const index = lower.indexOf(trigger);
    if (index === -1) continue;

    const after = question.slice(index + trigger.length).trim();
    const words = splitWords(after);
    if (words.length === 0) continue;

    return words.slice(0, 8).join(" ").trim();
  }

  return null;
}

/** Pull meaningful tokens from a natural-language question. */
export function extractQuestionTerms(question: string) {
  const tokens = normalizeQuestionWords(question).filter(
    (word) => word.length >= 2 && !STOP_WORDS.has(toLower(word)),
  );

  const phrases = extractTopicPhrases(question);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const item of [...phrases, ...tokens]) {
    const key = toLower(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique.slice(0, 8);
}
