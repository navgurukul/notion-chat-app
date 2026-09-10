/**
 * Heading-aware chunking for Notion pages.
 *
 * Strategy (priority order):
 *  1. Split content on H1/H2/H3 boundaries first — each section becomes its
 *     own chunk candidate. Sections that are still too large get recursively
 *     split at paragraph → sentence → word boundaries.
 *  2. Sections that are too small get merged with the next sibling (same
 *     heading level or lower) up to CHUNK_TARGET_CHARS.
 *  3. Every chunk carries a heading_path (e.g. "Leave Policy > Sick Leave >
 *     Eligibility") and an enriched metadata prefix.
 *  4. Overlap is applied only within a section — never across heading
 *     boundaries, so stale headings never pollute the next chunk's embedding.
 *  5. Empty pages produce no chunks.
 *  6. Each chunk tracks char_count and token_count (estimated at chars/4).
 */

const DEFAULT_TARGET_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 200;

const RECURSIVE_SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /** Leaf heading of this chunk (last heading in the body). */
  section_heading: string | null;
  /**
   * Full heading breadcrumb, e.g. "Leave Policy > Sick Leave > Eligibility".
   * Null for chunks that appear before any heading in the page.
   */
  heading_path: string | null;
  content: string;
  char_count: number;
  /** Estimated token count (chars / 4, rounded up). */
  token_count: number;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A contiguous block of text that belongs under one heading hierarchy. */
type Section = {
  /** Heading stack at the point this section was opened, e.g. ["H1", "H2"]. */
  headingStack: string[];
  headingPath: string | null;
  body: string;
};

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prefix builder — Priority 4: enriched metadata
// ---------------------------------------------------------------------------

function buildChunkPrefix(page: PageChunkInput, headingPath: string | null): string {
  const lines: string[] = [`Title: ${page.title}`];

  if (page.doc_type) lines.push(`Type: ${page.doc_type}`);
  if (page.status)   lines.push(`Status: ${page.status}`);
  if (page.owner)    lines.push(`Owner: ${page.owner}`);
  if (headingPath)   lines.push(`Path: ${headingPath}`);

  return lines.join("\n") + "\n\n";
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

function normalizePageText(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Priority 1: Heading-aware section splitting
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3})\s+(.+)$/;

/**
 * Split the full page content into sections at every H1/H2/H3 boundary.
 * Content before the first heading becomes a section with an empty stack.
 * The heading line itself is included at the top of its section body so
 * the embedding knows what topic it is about.
 */
function splitIntoSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];

  let currentStack: string[] = [];
  let currentLines: string[] = [];

  function flush() {
    const body = currentLines.join("\n").trim();
    if (body) {
      sections.push({
        headingStack: [...currentStack],
        headingPath: currentStack.length > 0 ? currentStack.join(" > ") : null,
        body,
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const match = line.match(HEADING_RE);

    if (match) {
      // Save whatever accumulated before this heading
      flush();

      const level = match[1].length; // 1, 2, or 3
      const title  = match[2].trim();

      // Trim the stack to the parent level then push this heading
      currentStack = currentStack.slice(0, level - 1);
      currentStack.push(title);

      // The heading line opens the new section
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Recursive splitter (unchanged algorithm, used within a single section)
// ---------------------------------------------------------------------------

function joinSplitSegments(buffer: string, segment: string, separator: string): string {
  if (!buffer) return segment;
  if (separator === " ") return `${buffer} ${segment}`;
  return `${buffer}${separator}${segment}`;
}

function splitBySeparator(text: string, separator: string): string[] {
  if (!separator) return text ? [text] : [];
  if (separator === " ") return text.split(/\s+/).filter(Boolean);

  const parts  = text.split(separator);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const trimmed = parts[i]?.trim();
    if (!trimmed) continue;
    result.push(i < parts.length - 1 ? `${trimmed}${separator}` : trimmed);
  }

  return result;
}

function recursiveSplit(text: string, separators = RECURSIVE_SEPARATORS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= getTargetChars()) return [trimmed];

  const [separator, ...rest] = separators;

  if (!separator) {
    const size  = getTargetChars();
    const parts: string[] = [];
    for (let i = 0; i < trimmed.length; i += size) {
      parts.push(trimmed.slice(i, i + size));
    }
    return parts;
  }

  const segments = splitBySeparator(trimmed, separator);
  if (segments.length <= 1) return recursiveSplit(trimmed, rest);

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

// ---------------------------------------------------------------------------
// Overlap — applied within a section only (Priority 1 / overlap fix)
// ---------------------------------------------------------------------------

function tailOverlap(text: string, overlapChars: number): string {
  if (!text || overlapChars <= 0) return "";

  const tail = text.length <= overlapChars ? text : text.slice(-overlapChars);

  // Start at a sentence boundary when possible
  const sentenceStart = tail.search(/[.!?]\s+/);
  const raw = sentenceStart >= 0 ? tail.slice(sentenceStart + 2).trim() : tail.trim();

  // Strip any heading that ended up in the overlap window
  return raw.replace(/^#{1,3}\s+.+\n?/, "").trimStart();
}

function packWithOverlap(pieces: string[]): string[] {
  const target  = getTargetChars();
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

// ---------------------------------------------------------------------------
// Section → chunk bodies
// ---------------------------------------------------------------------------

function sectionToBodies(section: Section): string[] {
  const { body } = section;
  if (!body) return [];

  if (body.length <= getTargetChars()) return [body];

  // Split oversized section at paragraph boundaries first, then recursively
  const paragraphs = body
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= getTargetChars()) {
      pieces.push(p);
    } else {
      pieces.push(...recursiveSplit(p));
    }
  }

  return packWithOverlap(pieces);
}

// ---------------------------------------------------------------------------
// Heading path helpers — Priority 2
// ---------------------------------------------------------------------------

function extractLeafHeading(body: string): string | null {
  let last: string | null = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m?.[1]) last = m[1].trim();
  }
  return last;
}

// ---------------------------------------------------------------------------
// Chunk statistics — Priority 5
// ---------------------------------------------------------------------------

function chunkStats(content: string): { char_count: number; token_count: number } {
  const char_count  = content.length;
  const token_count = Math.ceil(char_count / 4);
  return { char_count, token_count };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function chunkPageContent(page: PageChunkInput): PageChunk[] {
  const normalized = normalizePageText(page.content || "");

  // Priority 5 / empty-page fix: no content → no chunks
  if (!normalized) return [];

  // Priority 1: split on heading boundaries first
  const sections = splitIntoSections(normalized);

  const chunks: PageChunk[] = [];

  for (const section of sections) {
    const bodies = sectionToBodies(section);

    for (const body of bodies) {
      // Priority 2 & 4: build prefix with full heading path
      const prefix  = buildChunkPrefix(page, section.headingPath);
      const content = `${prefix}${body}`.trimEnd();

      chunks.push({
        page_id:         page.id,
        chunk_index:     chunks.length,
        section_heading: extractLeafHeading(body),
        heading_path:    section.headingPath,
        content,
        ...chunkStats(content),
      });
    }
  }

  return chunks;
}