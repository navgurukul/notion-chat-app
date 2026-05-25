/**
 * Extract Notion page titles from search queries — plain string logic.
 */
import {
  containsAnyPhrase,
  containsPhrase,
  extractBracketContent,
  extractBulletLineContent,
  splitOnTitleSeparators,
  splitWords,
  stripLeadingPrefixes,
  toLower,
} from "@/lib/shared/text-utils";

const QUESTION_PREFIXES = [
  "can you ",
  "summarize ",
  "summary of ",
  "explain ",
  "describe ",
  "what is ",
  "what's ",
  "tell me about ",
  "provide me with ",
  "provide ",
  "give me ",
  "give all data of ",
  "give data of ",
  "show me ",
  "show ",
];

const TITLE_HEAD_PREFIXES = [
  "what is",
  "what's",
  "summarize",
  "summary of",
  "explain",
  "describe",
  "tell me about",
  "can i get",
  "give me",
];

const LINK_WORDS = ["link", "url", "notion"];

export function explicitTitleFromQuery(searchQuery: string) {
  const fromBrackets = extractBracketContent(searchQuery);
  if (fromBrackets && fromBrackets.length >= 3) return fromBrackets;

  for (const line of searchQuery.split("\n")) {
    const bullet = extractBulletLineContent(line);
    if (!bullet) continue;
    if (bullet.startsWith("Current question:")) continue;

    const bulletLower = toLower(bullet);
    const isShortLinkRequest =
      bullet.length < 80 &&
      LINK_WORDS.some((word) => containsPhrase(bulletLower, word));
    if (isShortLinkRequest) continue;

    const head = splitOnTitleSeparators(
      stripLeadingPrefixes(bullet, TITLE_HEAD_PREFIXES),
    )[0];

    if (head && head.length >= 8) return head;
  }

  return null;
}

export function titleCandidates(searchQuery: string) {
  const normalized = searchQuery
    .split("“")
    .join('"')
    .split("”")
    .join('"')
    .split("‘")
    .join("'")
    .split("’")
    .join("'");

  const spaced = splitWords(normalized).join(" ");

  const splitParts = splitOnTitleSeparators(spaced).filter((part) => part.length >= 3);

  let questionRemoved = stripLeadingPrefixes(spaced, QUESTION_PREFIXES);

  const noisePhrases = [
    "what is",
    "what's",
    "core idea",
    "main idea",
    "summary",
    "explain",
    "provide",
    "detail",
    "details",
  ];

  for (const phrase of noisePhrases) {
    const index = toLower(questionRemoved).indexOf(phrase);
    if (index !== -1) {
      questionRemoved = questionRemoved.slice(0, index).trim();
    }
  }

  const candidates = [splitParts[0], questionRemoved, spaced].filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = toLower(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique.slice(0, 3);
}
