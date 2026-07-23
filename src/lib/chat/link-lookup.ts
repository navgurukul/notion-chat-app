import type { ChatHistoryItem } from "@/lib/ai/openai";
import { buildContextualSearchQuery } from "@/lib/chat/history";
import {
  containsPhrase,
  extractAllBracketContents,
  extractBracketContent,
  extractMarkdownH2Title,
  splitOnTitleSeparators,
  splitWords,
  stripLeadingPrefixes,
  toLower,
} from "@/lib/shared/text-utils";

const LINK_PHRASES = [
  "notion link",
  "notion url",
  " link",
  " url",
  "open in notion",
  "share the link",
  "share link",
];

const SKIP_BRACKET_TITLES = new Set([
  "open in notion",
  "database:",
  "page:",
  "[database",
  "untitled",
]);

const PAGE_QUESTION_PREFIXES = [
  "what is",
  "what's",
  "what are",
  "tell me about",
  "can you tell me about",
  "summarize",
  "summary of",
  "explain",
  "describe",
  "structuring",
];

const MANAGER_QUESTION_STARTS = [
  "who is the project manager",
  "who is the project lead",
  "who is the project owner",
  "who is the manager",
  "who is assigned",
  "which is the project manager",
];

const TITLE_HEAD_PREFIXES = [
  "what is",
  "what's",
  "what are",
  "tell me about",
  "can you tell me about",
  "summarize",
  "summary of",
  "explain",
  "describe",
  "give me",
];

export function isNotionLinkRequest(message: string) {
  const lower = toLower(message);
  return LINK_PHRASES.some((phrase) => containsPhrase(lower, phrase));
}

function isSkippedBracketTitle(title: string) {
  const lower = toLower(title);
  if (SKIP_BRACKET_TITLES.has(lower)) return true;
  return lower.startsWith("[database");
}

function hasDashOrColon(text: string) {
  return text.includes("—") || text.includes("–") || text.includes("-") || text.includes(":");
}

function titleFromUserTurn(content: string) {
  const line = content.split("\n")[0]?.trim() ?? "";
  if (line.length < 8 || isNotionLinkRequest(line)) return null;

  const lower = toLower(line);
  if (MANAGER_QUESTION_STARTS.some((start) => lower.startsWith(start))) return null;

  const looksLikePageQuestion =
    PAGE_QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix)) || hasDashOrColon(line);

  if (looksLikePageQuestion) {
    const head = splitOnTitleSeparators(
      stripLeadingPrefixes(line, TITLE_HEAD_PREFIXES),
    )[0];
    if (head && head.length >= 8) return head;
  }

  if (line.length >= 12 && !lower.startsWith("who ") && !lower.startsWith("which ") && !lower.startsWith("can i get")) {
    return splitOnTitleSeparators(line)[0]?.trim() || line;
  }

  return null;
}

function extractTitleFromLinkPhrase(message: string) {
  const lower = toLower(message);

  const quoteMarkers = ['"', "'"];
  for (const quote of quoteMarkers) {
    const linkFor = `link for ${quote}`;
    const urlFor = `url for ${quote}`;
    const index = Math.max(lower.indexOf(linkFor), lower.indexOf(urlFor));
    if (index === -1) continue;

    const quoteStart = message.indexOf(quote, index);
    if (quoteStart === -1) continue;

    const quoteEnd = message.indexOf(quote, quoteStart + 1);
    if (quoteEnd === -1) continue;

    const title = message.slice(quoteStart + 1, quoteEnd).trim();
    if (title.length >= 3) return title;
  }

  const triggers = ["link for ", "link of ", "link to ", "url for ", "url of ", "url to "];
  for (const trigger of triggers) {
    const index = lower.indexOf(trigger);
    if (index === -1) continue;

    let rest = message.slice(index + trigger.length).trim();
    if (rest.toLowerCase().startsWith("the ")) rest = rest.slice(4).trim();
    if (rest.toLowerCase().startsWith("page ")) rest = rest.slice(5).trim();

    const end = Math.min(
      rest.indexOf("?") === -1 ? rest.length : rest.indexOf("?"),
      rest.length,
    );
    const title = rest.slice(0, end).trim();

    const pronouns = new Set(["it", "this", "that"]);
    if (title.length >= 3 && !pronouns.has(toLower(title))) return title;
  }

  return null;
}

function messageUsesPronoun(message: string) {
  const words = splitWords(message).map((w) => toLower(w));
  return words.includes("it") || words.includes("this") || words.includes("that");
}

/** Resolve page title from brackets, explicit text, or chat history ("link for it"). */
export function extractReferencedTitle(message: string, history: ChatHistoryItem[]) {
  const fromBrackets = extractBracketContent(message);
  if (fromBrackets && fromBrackets.length >= 3 && !isSkippedBracketTitle(fromBrackets)) {
    return fromBrackets;
  }

  const fromLinkPhrase = extractTitleFromLinkPhrase(message);
  if (fromLinkPhrase) return fromLinkPhrase;

  if (!messageUsesPronoun(message)) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "user") continue;
    const fromTurn = titleFromUserTurn(history[i].content);
    if (fromTurn) return fromTurn;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "bot") continue;
    const heading = extractMarkdownH2Title(history[i].content);
    if (heading && heading.length >= 3) return heading;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const brackets = extractAllBracketContents(history[i].content);
    for (let j = brackets.length - 1; j >= 0; j -= 1) {
      const title = brackets[j];
      if (title.length >= 3 && !isSkippedBracketTitle(title)) return title;
    }
  }

  return null;
}

export function resolveSemanticSearchQuery(message: string, history: ChatHistoryItem[]) {
  const title = extractReferencedTitle(message, history);
  if (title && isNotionLinkRequest(message)) return title;
  return buildContextualSearchQuery(message, history);
}
