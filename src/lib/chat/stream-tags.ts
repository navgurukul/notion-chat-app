import {
  extractBetweenMarkers,
  removeStreamMarkers,
  splitParagraphs,
  toLower,
} from "@/lib/shared/text-utils";

export const STREAM_TAGS = {
  thinkingStart: "[[THINKING]]",
  thinkingEnd: "[[/THINKING]]",
  answerStart: "[[ANSWER]]",
  answerEnd: "[[/ANSWER]]",
} as const;

const INTERNAL_REASONING_STARTS = [
  "the user is asking",
  "i will scan",
  "i need to search",
  "let me search",
];

function stripInternalReasoningPrefix(text: string) {
  const lower = toLower(text);
  for (const start of INTERNAL_REASONING_STARTS) {
    if (!lower.startsWith(start)) continue;

    const doubleNewline = text.indexOf("\n\n");
    const hashLine = text.indexOf("\n#");
    const dashLine = text.indexOf("\n-");
    const starLine = text.indexOf("\n*");

    const cutPoints = [doubleNewline, hashLine, dashLine, starLine].filter((n) => n > 0);
    if (cutPoints.length > 0) {
      const cutAt = Math.min(...cutPoints);
      return text.slice(cutAt).trim();
    }
  }

  return text.trim();
}

export function stripStreamTags(text: string) {
  return removeStreamMarkers(text);
}

export function stripInternalReasoning(text: string) {
  return stripInternalReasoningPrefix(text);
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

  const paragraphs = splitParagraphs(trimmed);
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const paragraph of paragraphs) {
    const norm = toLower(paragraph);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    unique.push(paragraph);
  }

  return unique.join("\n\n");
}

/** Extract the final answer from a streamed model response (client display + server persistence). */
export function extractFinalAnswer(rawBuffer: string) {
  const answerBlock = extractBetweenMarkers(
    rawBuffer,
    STREAM_TAGS.answerStart,
    STREAM_TAGS.answerEnd,
  );

  let result = "";

  if (answerBlock) {
    result = stripInternalReasoning(stripStreamTags(answerBlock));
  } else {
    let afterThinking = rawBuffer;
    const thinkingBlock = extractBetweenMarkers(
      rawBuffer,
      STREAM_TAGS.thinkingStart,
      STREAM_TAGS.thinkingEnd,
    );
    if (thinkingBlock !== null) {
      const start = rawBuffer.toUpperCase().indexOf(STREAM_TAGS.thinkingStart);
      const end = rawBuffer.toUpperCase().indexOf(STREAM_TAGS.thinkingEnd);
      if (start !== -1 && end !== -1) {
        afterThinking = rawBuffer.slice(end + STREAM_TAGS.thinkingEnd.length).trim();
      }
    }

    if (afterThinking) {
      result = stripInternalReasoning(stripStreamTags(afterThinking));
    }
  }

  return dedupeRepeatedAnswer(result);
}
