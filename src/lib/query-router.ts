export type QueryKind =
  | "owner_list"
  | "owner_of"
  | "created_by_list"
  | "created_by_of"
  | "assigned_list"
  | "assigned_to_of"
  | "worked_on_list"
  | "project_manager_of"
  | "topic_list"
  | "type_of"
  | "status_of"
  | "semantic";

export type ParsedQuery = {
  kind: QueryKind;
  personName?: string;
  docTitle?: string;
  raw: string;
};

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripDocWords(value: string) {
  return value
    .replace(
      /\b(page|doc|document|docs|pages|project|projects|task|tasks|work|worked|assigned|assign|assignee|given|got|to|the|a|an|all|every|some|any|only|one)\b/gi,
      "",
    )
    .replace(/^(what|which|who|where|when|why|how|was|is)\s+/i, "")
    .replace(/[?!.,;]/g, "")
    .replace(/'s\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPersonName(value: string | null) {
  if (!value) return null;
  const cleaned = stripDocWords(value);
  if (!cleaned) return null;
  if (/^(what|which|who|when|where|why|how|is|was|are|were|task|tasks|project|projects|work|manager|lead|only|one)$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
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

  if (/\bwho\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\s+(.+?)(?:\?|$)/i,
    ]);
    return { kind: "project_manager_of", docTitle: docTitle ?? undefined, raw: question };
  }

  const topicAssignedToPersonMatch = question.match(
    /^(?:only\s+one\s+|one\s+|single\s+)?(?:tasks?|projects?|work|data|docs?|documents?|pages?)?\s*(?:of|for|in|on|about|related to)?\s*(.+?)\s+(?:assigned|assign|given)\s+to\s+(.+?)(?:\?|$)/i,
  );
  if (topicAssignedToPersonMatch?.[1] && topicAssignedToPersonMatch?.[2]) {
    return {
      kind: "assigned_list",
      docTitle: stripDocWords(topicAssignedToPersonMatch[1]),
      personName: cleanPersonName(topicAssignedToPersonMatch[2]) ?? undefined,
      raw: question,
    };
  }

  const personAssignedTopicMatch = question.match(
    /(?:assigned|assign|given)\s+to\s+(.+?)\s+(?:for|in|on|about|related to)\s+(.+?)(?:\?|$)/i,
  );
  if (personAssignedTopicMatch?.[1] && personAssignedTopicMatch?.[2]) {
    return {
      kind: "assigned_list",
      personName: cleanPersonName(personAssignedTopicMatch[1]) ?? undefined,
      docTitle: stripDocWords(personAssignedTopicMatch[2]),
      raw: question,
    };
  }

  // owner list: "show all docs owned by X"
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

  // created-by list
  if (
    /\b(all|list|show)\b.*\b(docs?|documents?|pages?)\b.*\bcreated by\b/i.test(q) ||
    /\bdocs?\s+created\s+by\b/i.test(q)
  ) {
    const personName = extractAfter(question, [/created by\s+(.+)$/i]);
    return { kind: "created_by_list", personName: personName ?? undefined, raw: question };
  }

  // worked-on list
  if (
    /\b(?:give me|show|list|provide)?\s*(?:data|docs?|tasks?|projects?)?\s*(?:of|about|related to)?\s*\w+.*\bthat\s+\w+.*\b(worked|workd|working|works|work)\b/i.test(q) ||
    /\bwhat\s+(?:tasks?|projects?|work)\s+\w+\s+(?:works|work)\b/i.test(q) ||
    /\b(?:what|which|show|list|all)\b.*\b(tasks?|projects?|work)\b.*\b(?:assigned|assign|given)\b.*\bto\s+\w/i.test(q) ||
    /\bwhat\s+(?:tasks?|projects?|work)\s+.+?\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)\b/i.test(q) ||
    /\bwhat\s+.+?\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)\s+(?:on\s+)?(?:tasks?|projects?|work)?\b/i.test(q) ||
    /\b[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}\s+(?:tasks?|projects?|work)\b/i.test(question) ||
    /\b(total|all|list|show|which|what)\b.*\b(tasks?|projects?|work)\b.*\b\w+\b.*\b(working|worked|workd|done|doing)\b/i.test(q) ||
    /\b(total|all|list|show)\b.*\b(tasks?|projects?)\b.*\b(for|of|by)\s+\w/i.test(q) ||
    /\b(tasks?|docs?|documents?|pages?|work)\b.*\b(by|of|for)\s+\w/i.test(q) ||
    /\bwhat\s+(has|did|have)\s+\w+\s+(been\s+)?(working|worked|done|doing)\b/i.test(q) ||
    /\bwhich\s+(tasks?|docs?|documents?|pages?)\b.*\b(work(ed)?|done|assigned)\b/i.test(q) ||
    /\b(worked|working)\s+on\s+by\b/i.test(q) ||
    /\btasks?\s+\w+\s+worked\b/i.test(q) ||
    /\bwhat\s+\w+\s+(worked|did|does|has)\b/i.test(q)
  ) {
    const topicTaskPersonMatch = question.match(
      /^(?:what\s+(?:was|is)\s+)?(.+?)\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:worked|workd|working|works|work)(?:\s+on)?/i,
    );
    if (topicTaskPersonMatch?.[1] && topicTaskPersonMatch?.[2]) {
      return {
        kind: "worked_on_list",
        docTitle: stripDocWords(topicTaskPersonMatch[1]),
        personName: cleanPersonName(topicTaskPersonMatch[2]) ?? undefined,
        raw: question,
      };
    }

    const possessiveWorkedOnMatch = question.match(
      /(?:give me|show|list|provide)?\s*(?:\b(?:data|docs?|tasks?|projects?)\b)?\s*(?:of|about)?\s*(.+?)'s\s+(?:worked|workd|working|work|works)\s+(?:on\s+)?(.+?)(?:\?|$)/i,
    );
    if (possessiveWorkedOnMatch?.[1] && possessiveWorkedOnMatch?.[2]) {
      return {
        kind: "worked_on_list",
        personName: cleanPersonName(possessiveWorkedOnMatch[1]) ?? undefined,
        docTitle: stripDocWords(possessiveWorkedOnMatch[2]),
        raw: question,
      };
    }

    const topicPersonMatch = question.match(
      /^(?:give me|show|list|provide)?\s*(?:\b(?:data|docs?|tasks?|projects?)\b)?\s*(?:of|about|related to)?\s*(.+?)\s+that\s+(.+?)\s+(?:has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:worked|workd|working|works|work)(?:\s+on)?/i,
    );
    if (topicPersonMatch?.[1] && topicPersonMatch?.[2]) {
      return {
        kind: "worked_on_list",
        docTitle: stripDocWords(topicPersonMatch[1]),
        personName: cleanPersonName(topicPersonMatch[2]) ?? undefined,
        raw: question,
      };
    }

    const personName = extractAfter(question, [
      /what\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)(?:\s+on)?/i,
      /what\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:works|work)\b/i,
      /(?:what|which|show|list|all)\b.*\b(?:tasks?|projects?|work)\b.*\b(?:assigned|assign|given)\b.*\bto\s+(.+)$/i,
      /what\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)/i,
      /what\s+(.+?)\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)/i,
      /^([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})\s+(?:tasks?|projects?|work)\b/i,
      /(?:total|all|list|show|which|what)\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:working|worked|done|doing)/i,
      /(?:total|all|list|show)\s+(?:tasks?|projects?)\s+(?:for|of|by)\s+(.+)$/i,
      /what\s+has\s+(.+?)\s+been\s+(working|worked)/i,
      /what\s+did\s+(.+?)\s+(work|do|done)/i,
      /which\s+tasks?\s+did\s+(.+?)\s+work/i,
      /which\s+tasks?\s+(?:did\s+)?(.+?)\s+work/i,
      /tasks?\s+(.+?)\s+worked/i,
      /what\s+(.+?)\s+(worked|did|does|has)\b/i,
      /worked\s+on\s+by\s+(.+)$/i,
      /\btasks?\s+(?:by|of|for)\s+(.+)$/i,
    ]);
    return { kind: "worked_on_list", personName: cleanPersonName(personName) ?? undefined, raw: question };
  }

  // owner of
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

  // created-by of
  if (/\bwho\s+created\b/i.test(q)) {
    const docTitle = extractAfter(question, [/who\s+created\s+(?:the\s+)?(.+)$/i]);
    return { kind: "created_by_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // assigned to / assignee of
  if (/\bwho\s+(is\s+)?assigned\s+to\b/i.test(q) || /\bassignee\s+of\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is\s+)?assigned\s+to\s+(?:the\s+)?(.+)$/i,
      /assignee\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "assigned_to_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // type of
  if (/\bwhat\s+(type|kind)\s+(is|of)\b/i.test(q) || /\btype\s+of\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /what\s+(?:type|kind)\s+is\s+(?:the\s+)?(.+)$/i,
      /what\s+is\s+the\s+(?:type|kind)\s+of\s+(?:the\s+)?(.+)$/i,
      /type\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "type_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // status of
  if (/\bwhat\s+is\s+the\s+status\s+of\b/i.test(q) || /\bstatus\s+of\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /status\s+of\s+(?:the\s+)?(.+)$/i,
      /what\s+is\s+the\s+status\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "status_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // topic list
  if (
    /\b(all|every|list|show|give me|provide)\b.{0,30}\b(data|docs?|documents?|pages?|tasks?|info|information|details?|related)\b/i.test(
      q,
    ) ||
    /\b(related|about)\b.{0,20}\b(all|every|complete|full)\b/i.test(q) ||
    /\ball.{0,20}(related|about)\b/i.test(q)
  ) {
    const topic = extractAfter(question, [
      /(?:all|every|list|show|give me|provide)\s+(?:me\s+)?(?:docs?|documents?|pages?|tasks?|data|info)\s+(?:related\s+to|about)\s+(.+?)(?:\?|$)/i,
      /(?:all|every|list|show|give me|provide)\s+(?:me\s+)?(.+?)\s+(?:related|about|data|docs?|documents?|tasks?|info|details?)/i,
      /(.+?)\s+related\s+all/i,
      /all\s+(.+?)\s+(?:related|data|docs?|tasks?|info)/i,
      /^(.+?)\s+related\b/i,
    ]);
    if (topic && topic.length >= 2) {
      return { kind: "topic_list", docTitle: topic, raw: question };
    }
  }

  return { kind: "semantic", raw: question };
}
