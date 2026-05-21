export const STREAM_TAGS = {
  thinkingStart: "[[THINKING]]",
  thinkingEnd: "[[/THINKING]]",
  answerStart: "[[ANSWER]]",
  answerEnd: "[[/ANSWER]]",
} as const;

const STREAM_TAG_PATTERN = /\[\[(?:\/)?(?:THINKING|ANSWER)\]\]/gi;
const INTERNAL_REASONING_PREFIX =
  /^(?:the user is asking|i will scan|i need to search|let me search)[\s\S]*?(?=\n\n|\n#|\n-|\n\*|$)/i;

export function stripStreamTags(text: string) {
  return text.replace(STREAM_TAG_PATTERN, "");
}

export function stripInternalReasoning(text: string) {
  return text.replace(INTERNAL_REASONING_PREFIX, "").trim();
}

/** Collapse accidental full-text repeats from stream parsing. */
export function dedupeRepeatedAnswer(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 200) return trimmed;

  const half = Math.floor(trimmed.length / 2);
  const first = trimmed.slice(0, half).trim();
  const second = trimmed.slice(half).trim();
  if (first.length > 80 && second.startsWith(first.slice(0, Math.min(120, first.length)))) {
    return first;
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  const unique: string[] = [];
  for (const p of paragraphs) {
    const norm = p.trim().toLowerCase();
    if (!norm) continue;
    if (unique.some((u) => u.trim().toLowerCase() === norm)) continue;
    unique.push(p);
  }
  return unique.join("\n\n");
}

/** Extract the final answer from a streamed model response (client display + server persistence). */
export function extractFinalAnswer(rawBuffer: string) {
  const answerBlock = rawBuffer.match(/\[\[ANSWER\]\]([\s\S]*?)(?:\[\[\/ANSWER\]\]|$)/i)?.[1];
  let result = "";

  if (answerBlock?.trim()) {
    result = stripInternalReasoning(stripStreamTags(answerBlock));
  } else {
    const afterThinking = rawBuffer
      .replace(/\[\[THINKING\]\][\s\S]*?\[\[\/THINKING\]\]/i, "")
      .trim();
    if (afterThinking) {
      result = stripInternalReasoning(stripStreamTags(afterThinking));
    }
  }

  return dedupeRepeatedAnswer(result);
}
