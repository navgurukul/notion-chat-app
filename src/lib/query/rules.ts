/**
 * Rule-based question classifier (legacy regex patterns).
 *
 * New code should prefer `@/lib/shared/text-utils` (plain string helpers) or the LLM
 * classifier in `intent-classifier.ts`. Regex here is only for fast routing fallbacks.
 *
 * Flow: `resolve-query.ts` tries these rules first, then LLM when confidence is low.
 */
export type { ParsedQuery, QueryKind, QuerySource } from "@/lib/query/types";

import {
  extractCrossDocSummaryTopic,
  extractYearFromQuestion,
  isCrossDocSummaryQuestion,
  looksLikeSinglePageTitle,
  normalizePersonNameForMatch,
  stripYearSuffixFromPerson,
  isNoiseTopic,
} from "@/lib/query/normalize";

export { isNoiseTopic };

export { extractCrossDocSummaryTopic, extractYearFromQuestion, isCrossDocSummaryQuestion };

type RulesQuery = Omit<import("@/lib/query/types").ParsedQuery, "confidence" | "source">;

function withYear(question: string, partial: Omit<RulesQuery, "raw" | "year">): RulesQuery {
  const year = extractYearFromQuestion(question);
  return { ...partial, year, raw: question };
}

// ─── Reusable keyword groups ────────────────────────────────────────────────
const PEOPLE_WORDS = ["developers", "developer", "devs", "dev", "engineers", "engineer", "people", "team members", "team member"];
const LIST_WORDS = ["list", "show", "display", "get"];
const COUNT_WORDS = ["how many", "number of", "total", "count"];

/** Build a case-insensitive regex that matches any of the given keywords. */
function keywordsPattern(words: string[], flags = "i"): RegExp {
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const joined = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(joined, flags);
}

const PEOPLE_PATTERN = keywordsPattern(PEOPLE_WORDS);
const LIST_PATTERN = keywordsPattern(LIST_WORDS);
const COUNT_PATTERN = keywordsPattern(COUNT_WORDS);

function preprocessQuestion(text: string) {
  return text
    .replace(/\bsummry\b/gi, "summary")
    .replace(/\bsummerrize\b/gi, "summarize")
    .replace(/\bsummarise\b/gi, "summarize");
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanPageTitle(value: string) {
  return value
    .replace(/^[-–—:\s]+/, "")
    .replace(/[?!.,;]+$/g, "")
    .trim();
}

function cleanComparePageTitle(value: string) {
  return cleanPageTitle(value)
    .replace(
      /\s+(?:scope|status|overview|features?|roadmap|differences?|comparison)(?:\s+in\s+scope)?$/i,
      "",
    )
    .trim();
}

const TRAILING_META_WORDS = /\s+(?:details?|info|information|about|spec|specs|specification|requirements?|prd)$/i;

export function cleanExtractedTitle(title: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ").trim();

  const canonicalPatterns = [
    /\bemployee\s+information\s+policy$/i,
    /\binformation\s+policy$/i,
    /\bproduct\s+requirements\s+document$/i,
    /\brequirements\s+document$/i,
    /\bprd\s+template$/i,
    /\bapi\s+specification$/i,
    /\bsecurity\s+requirements$/i,
  ];

  const isProtected = canonicalPatterns.some((pattern) => pattern.test(cleaned));

  if (!isProtected) {
    cleaned = cleaned.replace(TRAILING_META_WORDS, "").trim();
  }

  return cleaned;
}

function stripDocWords(value: string) {
  const step1 = value
    .replace(
      /\b(page|doc|document|docs|pages|project|projects|task|tasks|work|worked|assigned|assign|assignee|given|got|to|the|a|an|all|every|some|any|only|one|feature|features)\b/gi,
      "",
    )
    .replace(/^(what|which|who|where|when|why|how|was|is)\s+/i, "")
    .replace(/'s\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleanExtractedTitle(step1);
}

function cleanPersonName(value: string | null) {
  if (!value) return null;
  if (/\b(project|projects|page|pages|doc|docs|document|documents)\b/i.test(value)) {
    return null;
  }
  const cleaned = stripYearSuffixFromPerson(
    stripDocWords(value)
      .replace(/\s+(?:is|are|was|were|has|have|had)\s*$/i, "")
      .replace(/^(?:did|does|do|is|are|was|were|has|have|had)\s+/i, ""),
  ).trim();
  if (!cleaned) return null;
  if (/^(what|which|who|when|where|why|how|is|was|are|were|task|tasks|project|projects|work|manager|lead|only|one|there|here|any|some|me|my|he|him|she|her|they|them|its|their|someone|anyone|no\s+one|nobody|everyone|everybody)$/i.test(cleaned)) {
    return null;
  }
  return normalizePersonNameForMatch(cleaned);
}

function extractAfter(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return stripDocWords(match[1].trim());
  }
  return null;
}

function extractPageTitle(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const title = cleanPageTitle(match[1].trim());
      if (title.length >= 4) return title;
    }
  }
  return null;
}

function parseActivityQuery(question: string, q: string): RulesQuery | null {
  const teamActivityMatch =
    question.match(
      /\b(?:most|mostly|least|lowest|bottom)\s+active\s+(?:team\s+member|person|contributor|member)?\s*(?:in|on|for)\s+([^?.!]+?)(?:\?|$)/i,
    );
  if (teamActivityMatch?.[1]) {
    const docTitle = stripDocWords(teamActivityMatch[1]);
    return {
      kind: "team_activity",
      docTitle,
      raw: question,
      parserConfidence: 0.95,
    };
  }

  const teamRosterMatch =
    question.match(
      /\bwho(?:\s+all|\s+else)?\s+(?:is|are)\s+(?:all\s+)?(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    ) ??
    question.match(
      /\b(?:who\s+all|which\s+people|list\s+(?:all\s+)?(?:people|members|team))\b[\s\S]*?\b(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    ) ??
    question.match(
      /\b(?:how\s+many|number\s+of)\s+(?:people|members|team\s+members|devs|developers|engineers)\s+(?:are\s+)?(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    );
  if (teamRosterMatch?.[1]) {
    const docTitle = stripDocWords(teamRosterMatch[1]);
    const lowerDoc = docTitle.toLowerCase();
    const isSinglePage = /\b(mvp|app|page|list|prd|spec|sow|proposal|design|dashboard|task|issue|ticket|bug|screen|login|signup|ui|ux|frontend|backend|widget|widgets)\b/i.test(lowerDoc);
    if (!isSinglePage) {
      return {
        kind: "team_roster",
        docTitle,
        raw: question,
      };
    }
  }

  const projectWorkedInYearMatch =
    question.match(
      /\b(?:all\s+(?:the\s+)?)?projects?\s+(.+?)\s+(?:has|have)\s+worked(?:\s+on)?(?:\s+in\s+(20\d{2}))?/i,
    ) ??
    question.match(
      /\b(?:what|which)\s+projects?\s+(.+?)\s+(?:has|have)\s+worked(?:\s+on)?(?:\s+in\s+(20\d{2}))?/i,
    ) ??
    question.match(
      /\b(?:what|which)\s+projects?\s+(.+?)\s+worked(?:\s+on)?\s+in\s+(20\d{2})/i,
    ) ??
    question.match(
      /\b(?:what|which)\s+projects?\s+(?:did|does)\s+(.+?)\s+work\s+on\s+in\s+(20\d{2})/i,
    );
  if (projectWorkedInYearMatch?.[1]) {
    const person = cleanPersonName(projectWorkedInYearMatch[1]);
    if (person) {
      const yearFromGroup = projectWorkedInYearMatch[2];
      const year = yearFromGroup
        ? Number.parseInt(yearFromGroup, 10)
        : extractYearFromQuestion(question);
      return withYear(question, {
        kind: "activity_summary",
        personName: person,
        ...(year ? { year } : {}),
      });
    }
  }

  const tasksWorkedMatch =
    question.match(/\b(?:which|what)\s+tasks?\s+(.+?)\s+(?:has|have)\s+worked(?:\s+on)?/i) ??
    question.match(/\b(?:which|what)\s+tasks?\s+(?:did|has|have)\s+(.+?)\s+work(?:\s+on)?/i) ??
    question.match(/\b(?:which|what)\s+tasks?\s+(.+?)\s+worked(?:\s+on)?/i);
  if (tasksWorkedMatch?.[1]) {
    const person = cleanPersonName(tasksWorkedMatch[1]);
    if (person) {
      return withYear(question, { kind: "worked_on_list", personName: person });
    }
  }

  return null;
}

/** Title before a dash, e.g. "Structuring the Product Team — What's the core idea?" */
function extractLeadingPageTitle(question: string) {
  if (/^\s*compare\b/i.test(question)) return null;
  const match = question.match(
    /^(.+?)\s*[—–-]\s*(?:what'?s?(?:\s+the)?|how|why|who|when|the\s+core|tell|explain|describe|can you|give me)/i,
  );
  if (!match?.[1]) return null;
  const title = match[1].trim();
  if (/^compare\b/i.test(title)) return null;
  return title.length >= 8 ? title : null;
}

/** "Compare Oscar MVP and Oscar App — what's the difference?" */
export function extractCompareTitles(question: string): { a: string; b: string } | null {
  const match = question.match(
    /\bcompare\s+(.+?)\s+and\s+(.+?)(?:\s*[—–-]|\s*[,;]|\s+what\b|\s+what'?s\b|\?|$)/i,
  );
  if (!match?.[1] || !match?.[2]) return null;
  const a = cleanComparePageTitle(match[1].trim());
  const b = cleanComparePageTitle(match[2].trim());
  if (a.length < 2 || b.length < 2) return null;
  return { a, b };
}

/** Rule-based intent parse (legacy). Prefer {@link resolveQuery} in the chat API. */
export function parseQueryByRules(question: string): RulesQuery {
  const qn = preprocessQuestion(question);
  const q = normalize(qn);

  const activityQuery = parseActivityQuery(qn, q);
  if (activityQuery) return activityQuery;

  const possessiveTasksRegex = /^(?:what\s+about\s+)?([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})'s\s+(?:tasks?|work|projects?)(?:\?|$)/i;
  const possessiveTasksMatch = question.match(possessiveTasksRegex);
  if (possessiveTasksMatch) {
    const person = cleanPersonName(possessiveTasksMatch[1]);
    if (person) {
      return {
        kind: "assigned_list",
        personName: person,
        raw: question,
        parserConfidence: 0.95,
      };
    }
  }

  // Person-project membership checks
  const membershipRegex = /^(?:is|does|are)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:working\s+on|work\s+on|part\s+of|contributing\s+to|associated\s+with)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i;
  const membershipRegex2 = /^(?:is|are)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:on|in)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i;
  const membershipRegex3 = /^(?:is|does|are)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:the\s+)?(?:owner|manager|pm|lead)\s+(?:of|for|on)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i;

  const membershipMatch = question.match(membershipRegex) ?? question.match(membershipRegex2) ?? question.match(membershipRegex3);
  if (membershipMatch) {
    const person = cleanPersonName(membershipMatch[1]);
    const project = stripDocWords(membershipMatch[2]);
    if (person && project) {
      return {
        kind: "assignee_project_check",
        personName: person,
        docTitle: project,
        raw: question,
        parserConfidence: 0.95,
      };
    }
  }

  // People discovery patterns
  if (
    /^who\s+works\s+where[.?!]?\s*$/i.test(q) ||
    /^who\s+works?\s+on\s+what[.?!]?\s*$/i.test(q)
  ) {
    return { kind: "people_list", raw: question, parserConfidence: 0.95 };
  }

  const singleWordPeople = new RegExp(
    `^(?:${PEOPLE_PATTERN.source})[.?!]?\\s*$`, "i"
  );
  if (singleWordPeople.test(q)) {
    return { kind: "people_list", raw: question, parserConfidence: 0.90 };
  }

  const whoAreAll = new RegExp(
    `who\\s+(?:are\\s+all|all\\s+are)\\s+(?:the\\s+)?(?:${PEOPLE_PATTERN.source})\\b`, "i"
  );
  const listAllPeople = new RegExp(
    `^(?:${LIST_PATTERN.source})\\s+(?:all|every)\\s+(?:${PEOPLE_PATTERN.source})[.?!]?\\s*$`, "i"
  );
  const listPeople = new RegExp(
    `^(?:${LIST_PATTERN.source})\\s+(?:${PEOPLE_PATTERN.source})[.?!]?\\s*$`, "i"
  );
  const countPeople = new RegExp(
    `\\bhow\\s+many\\s+(?:total\\s+)?(?:${PEOPLE_PATTERN.source}|users)\\b`, "i"
  );
  const totalPeople = new RegExp(
    `\\btotal\\s+(?:number\\s+of\\s+)?(?:${PEOPLE_PATTERN.source}|users)\\b`, "i"
  );

  if (
    whoAreAll.test(q) ||
    listAllPeople.test(q) ||
    listPeople.test(q) ||
    countPeople.test(q) ||
    totalPeople.test(q) ||
    (/\b(?:list|show|get|display|who)\b.*\b(?:team\s+members?|people|members|users|devs)\b/i.test(q) &&
     !/\b(?:project|each\s+project|per\s+project|breakdown|by\s+project|project\s+wise)\b/i.test(q))
  ) {
    return { kind: "people_list", raw: question, parserConfidence: 0.95 };
  }

  if (/\bwhich\s+project\s+has\s+the\s+most\s+developers\b/i.test(q) || /\bprojects?\s+with\s+(?:the\s+)?most\s+devs\b/i.test(q)) {
    return { kind: "project_most_devs", raw: question, parserConfidence: 0.95 };
  }

  // project_member_breakdown: Group-by-project with member count and names
  const memberBreakdownPatterns = [
    /\b(?:show|list|get|display|give)\s+(?:all\s+)?(?:projects?|teams?)\s+(?:with\s+)?(?:members?|people|team\s+members?|team\s+size|member\s+count)\b/i,
    /\b(?:project|team|project\s+wise)\s*(?:members?|people|member\s+count|team\s+size|strength)\b/i,
    /\b(?:which|what)\s+(?:projects?|teams?)\s+(?:have|has)\s+(?:how\s+many|the\s+most|most)\s+(?:members?|people|devs|developers)\b/i,
    /\bgroup\s+(?:by|per)\s+(?:project|team)\b/i,
    /\b(?:per|by)\s+project\s+(?:member|team|people|strength)\b/i,
    /\bbreakdown\s+(?:of\s+)?(?:members?|people|team)\s+(?:by|per)\s+(?:project|team)\b/i,
  ];
  if (memberBreakdownPatterns.some(p => p.test(q))) {
    return { kind: "project_member_breakdown", raw: question, parserConfidence: 0.90 };
  }

  if (/\bwho\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\s+(.+?)(?:\?|$)/i,
    ]);
    return { kind: "project_manager_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // Implicit assigned list matching
  if (
    /^(?:show|list|get|display|what are the)\s+(?:all\s+)?(?:the\s+)?(?:assigned\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?)(?:\s+(?:assigned\s+)?to\s+me)?(?:\?|$)/i.test(q) ||
    /\bassigned\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)(?:\?|$)/i.test(q)
  ) {
    return {
      kind: "assigned_list",
      raw: question,
      parserConfidence: 0.95,
    };
  }

  // Person-project scoped tasks
  const tasksAssignedToPersonInProjectMatch = question.match(
    /\b(?:which|what)\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:are\s+)?assigned\s+to\s+(.+?)\s+in\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
  );
  if (tasksAssignedToPersonInProjectMatch?.[1] && tasksAssignedToPersonInProjectMatch?.[2]) {
    const person = cleanPersonName(tasksAssignedToPersonInProjectMatch[1]);
    const project = stripDocWords(tasksAssignedToPersonInProjectMatch[2]);
    if (person && project && !/^(?:the\s+)?(?:year\s+)?20\d{2}$/i.test(project.trim())) {
      return {
        kind: "assigned_list",
        personName: person,
        docTitle: project,
        raw: question,
        parserConfidence: 0.90,
      };
    }
  }

  // Person-only assigned tasks with optional year
  const tasksAssignedToYearMatch = question.match(
    /\b(?:which|what)\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:are\s+)?assigned\s+to\s+(.+?)(?:\s+in\s+(?:the\s+)?(?:year\s+)?(20\d{2}))?(?:\?|$)/i,
  );
  if (tasksAssignedToYearMatch?.[1]) {
    const person = cleanPersonName(tasksAssignedToYearMatch[1]);
    if (person) {
      const yearFromGroup = tasksAssignedToYearMatch[2];
      const year = yearFromGroup
        ? Number.parseInt(yearFromGroup, 10)
        : extractYearFromQuestion(question);
      return withYear(question, {
        kind: "assigned_list",
        personName: person,
        parserConfidence: 0.90,
        ...(year ? { year } : {}),
      });
    }
  }

  // "assigned to X" shortcut
  const assignedToDirectMatch = question.match(
    /^(?:show\s+)?assigned\s+to\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})(?:\?|$)/i
  );
  if (assignedToDirectMatch?.[1]) {
    const person = cleanPersonName(assignedToDirectMatch[1]);
    if (person) {
      return {
        kind: "assigned_list",
        personName: person,
        raw: question,
        parserConfidence: 0.95,
      };
    }
  }

  // "show/list assigned tasks for/to X"
  const showTasksMatch = q.match(/^(?:show|list|get|display)\s+(?:all\s+)?(?:of\s+)?(?:all\s+)?(?:the\s+)?(?:assigned\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:assigned\s+)?(?:to|for|of)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})/i)
    ?? q.match(/^(?:show|list|get|display)\s+(?:all\s+)?(?:of\s+)?(?:all\s+)?(?:the\s+)?([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})'s\s+(?:assigned\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?)/i);
  if (showTasksMatch) {
    const person = cleanPersonName(showTasksMatch[1]);
    if (person) {
      return {
        kind: "assigned_list",
        personName: person,
        raw: question,
        parserConfidence: 0.95,
      };
    }
  }

  // "what is/are X working on?"
  const workingOnMatch = q.match(/\b(?:what|which)\s+(?:projects?|tasks?|work)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:is|are|has|have)\s+(?:currently\s+)?(?:been\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\b/i)
    ?? q.match(/\b(?:what|which)\s+(?:projects?|tasks?|work)\s+(?:is|are|has|have)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:currently\s+)?(?:been\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\b/i)
    ?? q.match(/\b([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:is|are|has|have)?\s*(?:currently\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\s+(?:on\s+)?(?:which|what)\s+(?:tasks?|projects?|work)\b/i)
    ?? q.match(/\b([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:has|have|had)\s+(?:been\s+)?(?:working\s+on|worked\s+on|worked|done|doing)\s+(?:on\s+)?(?:which|what)\s+(?:tasks?|projects?|work)\b/i)
    ?? q.match(/\b(?:projects?|tasks?|work)\s+(?:worked\s+on|assigned\s+to)\s+by\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})/i);
  if (workingOnMatch?.[1]) {
    const person = cleanPersonName(workingOnMatch[1]);
    if (person) {
      return {
        kind: "assigned_list",
        personName: person,
        raw: question,
        parserConfidence: 0.95,
      };
    }
  }

  // Plan queries
  const planMatch = question.match(
    /\b(?:weekly|monthly|today|yesterday|daily)?\s*plans?\s+(?:for|of)\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})(?:\?|$)/i
  ) ?? question.match(
    /\b([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})'s\s+(?:weekly|monthly|today|yesterday|daily)?\s*plans?(?:\?|$)/i
  ) ?? question.match(
    /\b(?:what|which|show|list)\b.*\bplans?\b.*\b(?:for|of)?\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})(?:\?|$)/i
  );
  if (planMatch?.[1]) {
    const person = cleanPersonName(planMatch[1]);
    if (person) {
      return withYear(question, {
        kind: "assigned_list",
        personName: person,
        parserConfidence: 0.90,
      });
    }
  }

  // "Who is assigned to / working on X?"
  if (
    /\bwho\s+(?:is\s+)?assigned\s+to\b/i.test(q) ||
    /\bwho\s+(?:is\s+)?working\s+on\b/i.test(q) ||
    /\bwho\s+works\s+on\b/i.test(q) ||
    /\bwho\s+are\s+all\s+(?:the\s+)?(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\b/i.test(q) ||
    /\b(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\b/i.test(q) ||
    /\bassignee\s+of\b/i.test(q) ||
    /\b(?:how\s+many|number\s+of)\s+(?:people|members|team\s+members|devs|developers|engineers)\s+(?:are\s+)?(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is\s+)?assigned\s+to\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+(?:is\s+)?working\s+on\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+works\s+on\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+are\s+all\s+(?:the\s+)?(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /assignee\s+of\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:how\s+many|number\s+of)\s+(?:people|members|team\s+members|devs|developers|engineers)\s+(?:are\s+)?(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (docTitle) {
      return { kind: "assigned_to_of", docTitle: stripDocWords(docTitle), raw: question, parserConfidence: 0.95 };
    }
  }

  // "assigned to [person] in/for [project]"
  const personAssignedTopicMatch = question.match(
    /(?:assigned|assign|given)\s+to\s+(.+?)\s+(?:for|in|on|about|related to)\s+(.+?)(?:\?|$)/i,
  );
  if (personAssignedTopicMatch?.[1] && personAssignedTopicMatch?.[2]) {
    const person = cleanPersonName(personAssignedTopicMatch[1]);
    const project = stripDocWords(personAssignedTopicMatch[2]);
    if (person && project && !/^(?:the\s+)?(?:year\s+)?20\d{2}$/i.test(project.trim())) {
      return {
        kind: "assigned_list",
        personName: person,
        docTitle: project,
        raw: question,
        parserConfidence: 0.70,
      };
    }
  }

  // owner list
  if (
    /\b(all|list|show)\b.*\b(docs?|documents?|pages?)\b.*\bowned by\b/i.test(q) ||
    /\b(?:pages?|docs?|documents?)\s+owned\s+by\b/i.test(q) ||
    /\bdocs?\s+owned\s+by\b/i.test(q) ||
    /\bwhich\s+(docs?|documents?|pages?)\s+have\b.*\bas\s+owner\b/i.test(q)
  ) {
    const personName = extractAfter(question, [
      /(?:pages?|docs?|documents?)\s+owned\s+by\s+(.+?)(?:\?|$)/i,
      /owned by\s+(.+?)(?:\s+as\s+owner)?(?:\?|$)/i,
      /which\s+docs?\s+have\s+(.+?)\s+as\s+owner/i,
    ]);
    return { kind: "owner_list", personName: cleanPersonName(personName) ?? undefined, raw: question };
  }

  // created-by list
  if (
    /\b(all|list|show)\b.*\b(docs?|documents?|pages?)\b.*\bcreated by\b/i.test(q) ||
    /\bdocs?\s+created\s+by\b/i.test(q)
  ) {
    const personName = extractAfter(question, [/created by\s+(.+)$/i]);
    return { kind: "created_by_list", personName: personName ?? undefined, raw: question };
  }

  // worked-on list patterns
  if (
    /\b(mostly|most)\s+active\b/i.test(q) ||
    /\b(?:give me|show|list|provide)?\s*(?:data|docs?|tasks?|projects?)?\s*(?:of|about|related to)?\s*\w+.*\bthat\s+\w+.*\b(worked|workd|working|works|work)\b/i.test(q) ||
    /\bwhat\s+(?:tasks?|projects?|work)\s+\w+\s+(?:works|work)\b/i.test(q) ||
    /\b(?:what|which|show|list|all)\b.*\b(tasks?|projects?|work)\b.*\b(?:assigned|assign|given)\b.*\bto\s+\w/i.test(q) ||
    /\b(worked|working)\s+on\s+by\b/i.test(q)
  ) {
    const personName = extractAfter(question, [
      /\b(?:on|about|for|of)\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s+(?:tasks?|projects?|work)\b/i,
      /what\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)(?:\s+on)?/i,
      /what\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:works|work)\b/i,
      /(?:total|all|list|show|which|what)\s+(?:tasks?|projects?|work)\s+(.+?)\s+(?:has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:working|worked|done|doing)/i,
      /(?:total|all|list|show)\s+(?:tasks?|projects?)\s+(?:for|of|by)\s+(.+)$/i,
      /what\s+has\s+(.+?)\s+been\s+(working|worked)/i,
      /worked\s+on\s+by\s+(.+)$/i,
      /\btasks?\s+(?:by|of|for)\s+(.+)$/i,
    ]);
    return withYear(question, { kind: "worked_on_list", personName: cleanPersonName(personName) ?? undefined });
  }

  // "Which project does Souvik own?"
  const personOwnsProjectsMatch = question.match(
    /\b(?:which|what)\s+projects?\s+(?:does|do)\s+(.+?)\s+own\b/i,
  );
  if (personOwnsProjectsMatch?.[1]) {
    const person = cleanPersonName(personOwnsProjectsMatch[1]);
    if (person) {
      return { kind: "owner_list", personName: person, raw: question };
    }
  }

  // "Which project is Souvik the owner of?"
  const personIsOwnerOfMatch = question.match(
    /\b(?:which|what)\s+projects?\s+(?:is|are)\s+(.+?)\s+the\s+owner\s+of/i,
  );
  if (personIsOwnerOfMatch?.[1]) {
    const person = cleanPersonName(personIsOwnerOfMatch[1]);
    if (person) {
      return { kind: "owner_list", personName: person, raw: question };
    }
  }

  const whoOwnDashMatch = question.match(/\bwho\s+owns?\s*[-–—]\s*(.+?)(?:\?|$)/i);
  if (whoOwnDashMatch?.[1]) {
    const docTitle = cleanPageTitle(whoOwnDashMatch[1].trim());
    if (docTitle.length >= 2) {
      return { kind: "owner_of", docTitle, raw: question };
    }
  }

  // owner of
  if (
    /\bwho\s+(is\s+the\s+)?owner\s+of\b/i.test(q) ||
    /\bowner\s+of\b/i.test(q) ||
    /\bwho\s+owns\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /who\s+owns?\s*[-–—]\s*(.+?)(?:\?|$)/i,
      /who\s+owns\s+(?:the\s+)?(.+)$/i,
      /owner\s+of\s+(?:the\s+)?(.+)$/i,
      /who\s+(?:is\s+the\s+)?owner\s+of\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "owner_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // created-by of
  if (/\bwho\s+created\b/i.test(q) || /\bcreator\s+of\b/i.test(q) || /\bwho\s+(?:made|wrote|authored)\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /who\s+created\s+(?:the\s+)?(.+)$/i,
      /creator\s+of\s+(?:the\s+)?(.+)$/i,
      /who\s+(?:made|wrote|authored)\s+(?:the\s+)?(.+)$/i,
    ]);
    return { kind: "created_by_of", docTitle: docTitle ?? undefined, raw: question, parserConfidence: 0.95 };
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

  // blockers
  if (/\bblockers?\b/i.test(q)) {
    const workspaceWide =
      /\b(?:navgurukul|ng)\b/i.test(q) && /\bworkspace\b/i.test(q);
    const scope = workspaceWide
      ? undefined
      : extractAfter(question, [
          /blockers?\s+(?:in|across|for)\s+(?:the\s+)?(?:projects?\s+in\s+)?(.+?)(?:\?|$)/i,
          /(?:all|every)\s+(?:the\s+)?blockers?\s+(?:in|for)\s+(.+?)(?:\?|$)/i,
          /blockers?\s+in\s+(?:the\s+)?(.+?)\s+projects?/i,
        ]);
    return {
      kind: "blocker_list",
      docTitle: scope ? stripDocWords(scope) : undefined,
      raw: question,
    };
  }

  // ETA
  if (
    /\b(eta|estimated completion|completion date|target date)\b/i.test(q) ||
    /\bwhen\s+will\b.+\b(?:complete|done|ready|ship)\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /(?:eta|deadline|estimated completion)\s+(?:for\s+)?(?:completion\s+of\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
      /completion\s+of\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
      /when\s+will\s+(?:the\s+)?(?:project\s+)?(.+?)\s+(?:be\s+)?(?:complete|done|ready)/i,
    ]);
    if (docTitle && docTitle.length >= 3) {
      return { kind: "project_eta", docTitle: stripDocWords(docTitle), raw: question };
    }
  }

  // status of
  if (
    /\b(?:current\s+)?progress\s+on\b/i.test(q) ||
    /\bhow\s+is\s+.+\s+(?:progress|going)\b/i.test(q) ||
    /\bwhat\s+is\s+the\s+status\s+of\b/i.test(q) ||
    /\bstatus\s+of\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /(?:what\s+is\s+the\s+)?(?:current\s+)?progress\s+on\s+(?:the\s+(?:project\s+)?)?(.+?)(?:\?|$)/i,
      /how\s+is\s+(?:the\s+(?:project\s+)?)?(.+?)\s+(?:progress|going)/i,
      /status\s+of\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /what\s+is\s+the\s+status\s+of\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (docTitle && docTitle.length >= 2) {
      return { kind: "status_of", docTitle: stripDocWords(docTitle), raw: question };
    }
  }

  const compareTitles = extractCompareTitles(question);
  if (compareTitles) {
    return {
      kind: "compare_pages",
      docTitle: compareTitles.a,
      compareTitleB: compareTitles.b,
      raw: question,
    };
  }

  if (
    /\bonboarding\s+tasks?\b/i.test(q) ||
    (/\bnew\s+hire\b/i.test(q) && /\btasks?\b/i.test(q) && /\b(?:complete|need|do)\b/i.test(q))
  ) {
    return { kind: "onboarding_tasks", raw: question };
  }

  if (/\brisks?\b/i.test(q)) {
    const riskTopic = extractAfter(question, [
      /risks?\s+mentioned\s+for\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:main\s+)?risks?\s+(?:mentioned\s+)?(?:for|in|of|around)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /risks?\s+(?:for|in|of)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (riskTopic && riskTopic.length >= 2) {
      return { kind: "risks_for", docTitle: stripDocWords(riskTopic) || riskTopic, raw: question };
    }
  }

  const projectCostMatch = question.match(
    /^(.+?)\s+project\s+what\s+is\s+the\s+(cost\s+estimation|cost\s+estimate|budget)(?:\?|$)/i,
  );
  if (projectCostMatch?.[1]) {
    const topic = stripDocWords(projectCostMatch[1].trim());
    if (topic.length >= 3) {
      return { kind: "page_about", docTitle: topic, raw: question };
    }
  }

  if (/\b(cost\s+estimation|cost\s+estimate|what\s+is\s+the\s+budget)\b/i.test(q)) {
    const topicFromStart = question.match(/^(.+?)\s+(?:project\s+)?(?:what\s+is|what's).*(?:cost|budget)/i);
    const topic = topicFromStart?.[1] ? stripDocWords(topicFromStart[1]) : "";
    if (topic.length >= 4) {
      return { kind: "page_about", docTitle: topic, raw: question };
    }
  }

  const leadingTitle = extractLeadingPageTitle(question);
  if (leadingTitle) {
    return { kind: "page_about", docTitle: leadingTitle, raw: question };
  }

  const projectSummaryTopic = extractProjectSummaryTopic(question);
  if (projectSummaryTopic) {
    return { kind: "project_summary", docTitle: projectSummaryTopic, raw: question };
  }

  if (isCrossDocSummaryQuestion(question)) {
    const topic = extractCrossDocSummaryTopic(question);
    return { kind: "semantic", docTitle: topic, raw: question };
  }

  // summarize / purpose of a page
  if (
    /\b(summarize|summar(?:y|ize|ry)|summary\s+of|provide\s+(?:a\s+)?summar|give\s+(?:me\s+)?(?:a\s+)?summar)\b/i.test(q) ||
    /\bwhat\s+is\b.+\bfor(?:\?|$)/i.test(q) ||
    /\bwhat'?s\s+happening\b/i.test(q)
  ) {
    const docTitle = extractPageTitle(qn, [
      /(?:provide|give)(?:\s+me)?\s+(?:a\s+)?summar(?:y|ize|ry)\s+(?:of|for)\s*[-–—]?\s*(.+?)(?:\?|$)/i,
      /(?:summarize|summerrize|summary)\s*[-–—]\s*(.+?)(?:\?|$)/i,
      /summarize\s+(?:what\s+)?(?:the\s+)?(.+?)\s+is\s+for(?:\?|$)/i,
      /(?:summarize|summary\s+of)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /summary\s+of\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:what is|what's)\s+(?:the\s+)?(.+?)\s+for(?:\?|$)/i,
      /what'?s\s+happening\s+(?:with|on|in)?\s*(?:the\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (docTitle && looksLikeSinglePageTitle(docTitle)) {
      if (
        /\bsummar/i.test(q) &&
        docTitle.split(/\s+/).length <= 3 &&
        !/[-–—]/.test(docTitle) &&
        !/\b(hub|report|platform|session|proposal)\b/i.test(docTitle)
      ) {
        return { kind: "semantic", docTitle: stripDocWords(docTitle), raw: question };
      }
      return { kind: "page_about", docTitle, raw: question };
    }
  }

  // page details shortcut
  if (/\b(?:tell\s+me\s+more\s+about|more\s+about|details|info|information)\s+(?:of|about|for|on)?\s*(.+?)(?:\?|$)/i.test(q) || /^(?:show\s+)?(.+?)\s+(?:details|info|information)\??$/i.test(q)) {
    const match = question.match(/\b(?:tell\s+me\s+more\s+about|more\s+about|details|info|information)\s+(?:of|about|for|on)?\s*(.+?)(?:\?|$)/i) ?? question.match(/^(?:show\s+)?(.+?)\s+(?:details|info|information)\??$/i);
    const doc = stripDocWords(match?.[1] || "");
    if (doc) {
      return { kind: "page_about", docTitle: doc, raw: question, parserConfidence: 0.95 };
    }
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

/** "summarize datapivot ai project", "overview of Oscar" */
export function extractProjectSummaryTopic(question: string) {
  const q = question.trim();
  if (/\bsummarize\s+what\b/i.test(q) || /\bwhat\b.+\bis\s+for\b/i.test(q)) {
    return null;
  }

  const hasProgramIntent =
    (/\b(summarize|summary|overview)\b/i.test(q) &&
      (/\bproject\b/i.test(q) || /\boverview\b/i.test(q))) ||
    /\bwhat\s+is\s+(?:the\s+)?.+\s+project\s*\??$/i.test(q);

  if (!hasProgramIntent) return null;

  const patterns = [
    /\b(?:summarize|summary of|give me an overview of|overview of)\s+(?:the\s+)?(.+?)(?:\s+project)?\s*\??$/i,
    /\b(?:describe|explain)\s+(?:the\s+)?(.+?)\s+project\s*\??$/i,
    /\bwhat\s+is\s+(?:the\s+)?(.+?)\s+project\s*\??$/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match?.[1]) continue;
    const topic = match[1]
      .replace(/\s+project\s*$/i, "")
      .replace(/[?!.,;]+$/g, "")
      .trim();
    const cleaned = stripDocWords(topic) || topic;
    if (cleaned.length >= 3 && !/^(the|a|an|this|that)$/i.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

/** @deprecated Prefer {@link resolveQuery} from `@/lib/query/resolve-query`. */
export { parseQueryByRules as parseQuery };
