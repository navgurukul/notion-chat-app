/**
 * Structure-aware recursive chunking (RecursiveCharacterTextSplitter-style).
 * Preserves Notion headings/paragraphs; avoids mid-sentence fixed-word cuts.
 */

const DEFAULT_TARGET_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 350;

const RECURSIVE_SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

export type PageChunkInput = {
  id: string;
  title: string;
  content: string;
  owner?: string | null;
  status?: string | null;
  doc_type?: string | null;
  created_by?: string | null;
  last_edited_by?: string | null;
};

export type PageChunk = {
  page_id: string;
  chunk_index: number;
  section_heading: string | null;
  content: string;
};

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getTargetChars() {
  return readPositiveInt(process.env.CHUNK_TARGET_CHARS, DEFAULT_TARGET_CHARS);
}

function getOverlapChars() {
  return readPositiveInt(process.env.CHUNK_OVERLAP_CHARS, DEFAULT_OVERLAP_CHARS);
}

function buildChunkPrefix(page: PageChunkInput) {
  const meta = [
    page.owner ? `Owner: ${page.owner}` : "",
    page.status ? `Status: ${page.status}` : "",
    page.doc_type ? `Type: ${page.doc_type}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return meta
    ? `Title: ${page.title}\n${meta}\n\n`
    : `Title: ${page.title}\n\n`;
}

function normalizePageText(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split on blank lines first (Notion blocks are joined with newlines). */
function splitParagraphs(text: string) {
  return text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function joinSplitSegments(buffer: string, segment: string, separator: string) {
  if (!buffer) return segment;
  if (separator === " ") return `${buffer} ${segment}`;
  return `${buffer}${separator}${segment}`;
}

function splitBySeparator(text: string, separator: string): string[] {
  if (!separator) return text ? [text] : [];
  if (separator === " ") return text.split(/\s+/).filter(Boolean);

  const parts = text.split(separator);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const trimmed = parts[i]?.trim();
    if (!trimmed) continue;
    result.push(i < parts.length - 1 ? `${trimmed}${separator}` : trimmed);
  }

  return result;
}

/** LangChain-style recursive split: prefer paragraph/sentence/word boundaries. */
function recursiveSplit(text: string, separators = RECURSIVE_SEPARATORS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= getTargetChars()) return [trimmed];

  const [separator, ...rest] = separators;
  if (!separator) {
    const size = getTargetChars();
    const parts: string[] = [];
    for (let i = 0; i < trimmed.length; i += size) {
      parts.push(trimmed.slice(i, i + size));
    }
    return parts;
  }

  const segments = splitBySeparator(trimmed, separator);
  if (segments.length <= 1) {
    return recursiveSplit(trimmed, rest);
  }

  const merged: string[] = [];
  let buffer = "";

  for (const segment of segments) {
    const candidate = joinSplitSegments(buffer, segment, separator);
    if (candidate.length <= getTargetChars()) {
      buffer = candidate;
      continue;
    }

    if (buffer) merged.push(buffer.trim());

    if (segment.length <= getTargetChars()) {
      buffer = segment;
    } else {
      merged.push(...recursiveSplit(segment, rest));
      buffer = "";
    }
  }

  if (buffer.trim()) merged.push(buffer.trim());
  return merged.filter(Boolean);
}

function expandOversizedPieces(paragraphs: string[]) {
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= getTargetChars()) {
      pieces.push(paragraph);
    } else {
      pieces.push(...recursiveSplit(paragraph));
    }
  }
  return pieces;
}

function tailOverlap(text: string, overlapChars: number) {
  if (!text || overlapChars <= 0) return "";
  if (text.length <= overlapChars) return text;
  const tail = text.slice(-overlapChars);
  const sentenceStart = tail.search(/[.!?]\s+/);
  return sentenceStart >= 0 ? tail.slice(sentenceStart + 2).trim() : tail.trim();
}

function packPiecesWithOverlap(pieces: string[]) {
  const target = getTargetChars();
  const overlap = Math.min(getOverlapChars(), Math.floor(target / 3));
  const packed: string[] = [];

  let current = "";

  for (const piece of pieces) {
    if (!piece) continue;

    if (!current) {
      current = piece;
      continue;
    }

    const candidate = `${current}\n\n${piece}`;
    if (candidate.length <= target) {
      current = candidate;
      continue;
    }

    packed.push(current);
    const overlapText = tailOverlap(current, overlap);
    current = overlapText ? `${overlapText}\n\n${piece}` : piece;
  }

  if (current.trim()) packed.push(current.trim());
  return packed;
}

function extractSectionHeading(chunkBody: string) {
  const lines = chunkBody.split("\n");
  let lastHeading: string | null = null;

  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match?.[1]) {
      lastHeading = match[1].trim();
    }
  }

  return lastHeading;
}

export function chunkPageContent(page: PageChunkInput): PageChunk[] {
  const prefix = buildChunkPrefix(page);
  const normalized = normalizePageText(page.content || "");

  if (!normalized) {
    return [
      {
        page_id: page.id,
        chunk_index: 0,
        section_heading: null,
        content: prefix.trimEnd(),
      },
    ];
  }

  const paragraphs = splitParagraphs(normalized);
  const pieces = expandOversizedPieces(paragraphs);
  const bodies =
    pieces.length > 0 ? packPiecesWithOverlap(pieces) : packPiecesWithOverlap([normalized]);

  return bodies.map((body, index) => ({
    page_id: page.id,
    chunk_index: index,
    section_heading: extractSectionHeading(body),
    content: `${prefix}${body}`.trimEnd(),
  }));
}
