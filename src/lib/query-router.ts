/**
 * Query Router — Layer 2
 *
 * Classifies incoming questions and routes them to the correct handler:
 *   - METADATA  → SQL query on notion_pages table (accurate, no AI)
 *   - SEMANTIC  → pgvector similarity search → DeepSeek
 */

export type QueryKind =
  | "owner_list"       // "show all docs owned by X"
  | "owner_of"         // "who is the owner of doc X"
  | "created_by_list"  // "show all docs created by X"
  | "created_by_of"    // "who created doc X"
  | "worked_on_list"   // "which tasks did X work on"
  | "topic_list"       // "show all zuvy related data" / "all docs about X"
  | "type_of"          // "what type is doc X"
  | "status_of"        // "what is the status of doc X"
  | "semantic";        // everything else → vector search

export type ParsedQuery = {
  kind: QueryKind;
  // For list queries: the person name to filter by
  personName?: string;
  // For single-doc queries: the doc title to look up
  docTitle?: string;
  // Original raw question
  raw: string;
};

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripDocWords(value: string) {
  return value
    .replace(/\b(page|doc|document|docs|pages|the|a|an|all|every|some|any)\b/gi, "")
    .replace(/[?!.,;]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAfter(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return stripDocWords(match[1].trim());
  }
  return null;
}

export function parseQuery(question: string): ParsedQuery {
  const q = normalize(question);

  // --- Owner list: "show all docs owned by X" / "which docs have X as owner"
  if (
    /\b(all|list|show)\b.*\b(docs?|documents?|pages?)\b.*\bowned by\b/i.test(q) ||
    /\bdocs?\s+owned\s+by\b/i.test(q) ||
    /\bwhich\s+(docs?|documents?|pages?)\s+have\b.*\bas\s+owner\b/i.test(q)
  ) {
    const personName = extractAfter(question, [
      /owned by\s+(.+?)(?:\s+as\s+owner)?$/i,
      /which\s+docs?\s+have\s+(.+?)\s+as\s+owner/i,
    ]);
    return { kind: "owner_list", personName: personName ?? undefined, raw: question };
  }

  // --- Created by list: "show all docs created by X"
  if (
    /\b(all|list|show)\b.*\b(docs?|documents?|pages?)\b.*\bcreated by\b/i.test(q) ||
    /\bdocs?\s+created\s+by\b/i.test(q)
  ) {
    const personName = extractAfter(question, [/created by\s+(.+)$/i]);
    return { kind: "created_by_list", personName: personName ?? undefined, raw: question };
  }

  // --- Worked on list: "which tasks did X work on" / "what has X been working on" / "X's tasks"
  if (
    /\b(tasks?|docs?|documents?|pages?|work)\b.*\b(by|of|for)\s+\w/i.test(q) ||
    /\bwhat\s+(has|did|have)\s+\w+\s+(been\s+)?(working|worked|done|doing)\b/i.test(q) ||
    /\bwhich\s+(tasks?|docs?|documents?|pages?)\b.*\b(work(ed)?|done|assigned)\b/i.test(q) ||
    /\b(worked|working)\s+on\s+by\b/i.test(q) ||
    /\btasks?\s+\w+\s+worked\b/i.test(q) ||
    /\bwhat\s+\w+\s+(worked|did|does|has)\b/i.test(q)
  ) {
    const personName =
      extractAfter(question, [
        /what\s+has\s+(.+?)\s+been\s+(working|worked)/i,
        /what\s+did\s+(.+?)\s+(work|do|done)/i,
        /which\s+tasks?\s+did\s+(.+?)\s+work/i,
        /which\s+tasks?\s+(?:did\s+)?(.+?)\s+work/i,
        /tasks?\s+(.+?)\s+worked/i,
        /what\s+(.+?)\s+(worked|did|does|has)\b/i,
        /worked\s+on\s+by\s+(.+)$/i,
        /\btasks?\s+(?:by|of|for)\s+(.+)$/i,
      ]);
    return { kind: "worked_on_list", personName: personName ?? undefined, raw: question };
  }

  // --- Owner of doc: "who is the owner of X" / "who owns X"
  if (
    /\bwho\s+(is\s+the\s+)?owner\s+of\b/i.test(q) ||
    /\bowner\s+of\b/i.test(q) ||
    /\bwho\s+owns\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /who\s+owns\s+(?:the\s+)?(.+)$/i,
      /owner\s+of\s+(?:the\s+)?(.+)$/i,
      /who\s+(?:is\s+the\s+)?owner\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "owner_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // --- Created by of doc: "who created X"
  if (/\bwho\s+created\b/i.test(q)) {
    const docTitle = extractAfter(question, [/who\s+created\s+(?:the\s+)?(.+)$/i]);
    return { kind: "created_by_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // --- Type of doc: "what type is X" / "what is the type of X"
  if (/\bwhat\s+(type|kind)\s+(is|of)\b/i.test(q) || /\btype\s+of\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /what\s+(?:type|kind)\s+is\s+(?:the\s+)?(.+)$/i,
      /what\s+is\s+the\s+(?:type|kind)\s+of\s+(?:the\s+)?(.+)$/i,
      /type\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "type_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // --- Status of doc
  if (/\bwhat\s+is\s+the\s+status\s+of\b/i.test(q) || /\bstatus\s+of\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /status\s+of\s+(?:the\s+)?(.+)$/i,
      /what\s+is\s+the\s+status\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "status_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // --- Topic list: "all zuvy data" / "show everything about X" / "X related all data"
  if (
    /\b(all|every|list|show|give me|provide)\b.{0,30}\b(data|docs?|documents?|pages?|tasks?|info|information|details?|related)\b/i.test(q) ||
    /\b(related|about)\b.{0,20}\b(all|every|complete|full)\b/i.test(q) ||
    /\ball.{0,20}(related|about)\b/i.test(q)
  ) {
    // Extract the topic keyword — the main subject word(s)
    const topic = extractAfter(question, [
      // "all docs related to PDLD" / "all pages about X"
      /(?:all|every|list|show|give me|provide)\s+(?:me\s+)?(?:docs?|documents?|pages?|tasks?|data|info)\s+(?:related\s+to|about)\s+(.+?)(?:\?|$)/i,
      // "show me all Zuvy related data" → captures "Zuvy"
      /(?:all|every|list|show|give me|provide)\s+(?:me\s+)?(.+?)\s+(?:related|about|data|docs?|documents?|tasks?|info|details?)/i,
      /(.+?)\s+related\s+all/i,
      /all\s+(.+?)\s+(?:related|data|docs?|tasks?|info)/i,
      // "zuvy related all data"
      /^(.+?)\s+related\b/i,
    ]);
    if (topic && topic.length >= 2) {
      return { kind: "topic_list", docTitle: topic, raw: question };
    }
  }

  return { kind: "semantic", raw: question };
}
