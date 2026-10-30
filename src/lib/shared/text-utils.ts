/**
 * Plain string helpers — no regex required to read or maintain.
 * Use these instead of scattered /pattern/ code for common text tasks.
 */

/** Collapse repeated spaces and trim. */
export function normalizeSpaces(text: string) {
  return text.split(/\s+/).filter(Boolean).join(" ").trim();
}

/** Lowercase for case-insensitive comparisons. */
export function toLower(text: string) {
  return text.toLowerCase();
}

/** Split on whitespace into words (after normalizing spaces). */
export function splitWords(text: string) {
  return normalizeSpaces(text).split(" ").filter(Boolean);
}

/** Keep only letters, numbers, spaces, apostrophes, hyphens. */
export function keepLettersNumbersAndSpaces(text: string) {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isLetter =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (isLetter || isDigit || char === " " || char === "'" || char === "-") {
      out += char;
    } else {
      out += " ";
    }
  }
  return normalizeSpaces(out);
}

/** True if `text` contains `phrase` (case-insensitive). */
export function containsPhrase(text: string, phrase: string) {
  return toLower(text).includes(toLower(phrase));
}

/** True if any phrase appears in text. */
export function containsAnyPhrase(text: string, phrases: string[]) {
  return phrases.some((phrase) => containsPhrase(text, phrase));
}

/** True if text starts with any prefix (case-insensitive). */
export function startsWithAny(text: string, prefixes: string[]) {
  const lower = toLower(text);
  return prefixes.some((prefix) => lower.startsWith(toLower(prefix)));
}

/** Remove leading prefixes repeatedly until none match. */
export function stripLeadingPrefixes(text: string, prefixes: string[]) {
  let result = text.trim();

  let changed = true;
  while (changed) {
    changed = false;
    const lower = toLower(result);

    for (const prefix of prefixes) {
      const p = toLower(prefix);
      if (lower === p) {
        result = "";
        changed = true;
        break;
      }
      if (lower.startsWith(`${p} `)) {
        result = result.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

/** Text inside the first `[...]` brackets, or null. */
export function extractBracketContent(text: string) {
  const open = text.indexOf("[");
  if (open === -1) return null;

  const close = text.indexOf("]", open + 1);
  if (close === -1) return null;

  const inner = text.slice(open + 1, close).trim();
  return inner || null;
}

/** All `[...]` contents in order. */
export function extractAllBracketContents(text: string) {
  const results: string[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const open = text.indexOf("[", searchFrom);
    if (open === -1) break;

    const close = text.indexOf("]", open + 1);
    if (close === -1) break;

    const inner = text.slice(open + 1, close).trim();
    if (inner) results.push(inner);

    searchFrom = close + 1;
  }

  return results;
}

/** First calendar year like 2024–2099 found in text. */
export function extractYear(text: string): number | undefined {
  for (const word of splitWords(text)) {
    if (word.length !== 4 || !word.startsWith("20")) continue;

    const year = Number.parseInt(word, 10);
    if (year >= 2020 && year <= 2099) return year;
  }

  return undefined;
}

/** Split title-like text on dash / colon separators. */
export function splitOnTitleSeparators(text: string) {
  const separators = [" — ", " – ", " - ", " : ", " —", " –", " -", ":"];
  const parts = [text.trim()];

  for (const separator of separators) {
    const next: string[] = [];
    for (const part of parts) {
      if (part.includes(separator)) {
        next.push(...part.split(separator).map((p) => p.trim()).filter(Boolean));
      } else {
        next.push(part);
      }
    }
    parts.length = 0;
    parts.push(...next);
  }

  return parts.filter(Boolean);
}

/**
 * Text after the first matching trigger phrase.
 * Example: extractAfterPhrase("status on Oscar MVP", ["status on"]) → "Oscar MVP"
 */
export function extractAfterPhrase(
  text: string,
  triggers: string[],
  options?: { maxLength?: number; skipLeadingWords?: string[] },
) {
  const maxLength = options?.maxLength ?? 60;
  const skipLeading = new Set(
    (options?.skipLeadingWords ?? ["the", "a", "project"]).map((w) => w.toLowerCase()),
  );

  const lower = toLower(text);

  for (const trigger of triggers) {
    const index = lower.indexOf(toLower(trigger));
    if (index === -1) continue;

    let rest = text.slice(index + trigger.length).trim();

    let words = splitWords(rest);
    while (words.length > 0 && skipLeading.has(words[0].toLowerCase())) {
      words = words.slice(1);
    }

    rest = words.join(" ").trim();
    if (!rest) return null;

    return rest.length > maxLength ? rest.slice(0, maxLength).trim() : rest;
  }

  return null;
}

/** Remove a whole word (case-insensitive) from text. */
export function removeWord(text: string, word: string) {
  const target = toLower(word);
  return splitWords(text)
    .filter((part) => toLower(part) !== target)
    .join(" ")
    .trim();
}

/** Strip known stream markers like [[THINKING]] from model output. */
export function removeStreamMarkers(text: string) {
  const markers = [
    "[[THINKING]]",
    "[[/THINKING]]",
    "[[ANSWER]]",
    "[[/ANSWER]]",
  ];

  let result = text;
  for (const marker of markers) {
    while (result.includes(marker)) {
      result = result.split(marker).join("");
    }
    const upper = marker.toUpperCase();
    while (result.toUpperCase().includes(upper)) {
      const idx = result.toUpperCase().indexOf(upper);
      result = result.slice(0, idx) + result.slice(idx + marker.length);
    }
  }

  return result;
}

/** Content between start and end markers (case-insensitive), or null. */
export function extractBetweenMarkers(text: string, startMarker: string, endMarker: string) {
  const upper = text.toUpperCase();
  const start = upper.indexOf(startMarker.toUpperCase());
  if (start === -1) return null;

  const contentStart = start + startMarker.length;
  const end = upper.indexOf(endMarker.toUpperCase(), contentStart);

  const slice =
    end === -1 ? text.slice(contentStart) : text.slice(contentStart, end);

  return slice.trim() || null;
}

/** First markdown H2 heading: ## Title */
export function extractMarkdownH2Title(text: string) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("## ")) continue;
    const title = trimmed.slice(3).trim();
    if (title) return title;
  }
  return null;
}

/** Line starting with "- " (bullet), returns content after dash. */
export function extractBulletLineContent(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) return null;
  return trimmed.slice(2).trim() || null;
}

/** Split into paragraphs (blank line separated). */
export function splitParagraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}
