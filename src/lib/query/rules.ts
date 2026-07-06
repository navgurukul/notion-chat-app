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

function preprocessQuestion(text: string) {
  return text
    .replace(/\bsummry\b/gi, "summary")
    .replace(/\bsummerrize\b/gi, "summarize")
    .replace(/\bsummarise\b/gi, "summarize");
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Trim leading punctuation from extracted page titles. */
function cleanPageTitle(value: string) {
  return value
    .replace(/^[-–—:\s]+/, "")
    .replace(/[?!.,;]+$/g, "")
    .trim();
}

/** Strip question framing words often captured after the second page name in compare queries. */
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

  // Normalize punctuation and extra spaces
  cleaned = cleaned.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ").trim();

  // Safeguard canonical page titles:
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
    // Remove trailing conversational meta suffixes
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
  const cleaned = stripYearSuffixFromPerson(
    stripDocWords(value)
      .replace(/\s+(?:is|are|was|were|has|have|had)\s*$/i, "")
      .replace(/^(?:did|does|do|is|are|was|were|has|have|had)\s+/i, ""),
  ).trim();
  if (!cleaned) return null;
  if (/^(what|which|who|when|where|why|how|is|was|are|were|task|tasks|project|projects|work|manager|lead|only|one)$/i.test(cleaned)) {
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

/** Activity / recency questions — must run before the broad worked_on_list gate. */
function parseActivityQuery(question: string, q: string): RulesQuery | null {
  const teamRosterMatch =
    question.match(
      /\bwho(?:\s+all|\s+else)?\s+(?:is|are)\s+(?:all\s+)?(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    ) ??
    question.match(
      /\b(?:who\s+all|which\s+people|list\s+(?:all\s+)?(?:people|members|team))\b[\s\S]*?\b(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    );
  if (teamRosterMatch?.[1]) {
    return {
      kind: "team_roster",
      docTitle: stripDocWords(teamRosterMatch[1]),
      raw: question,
    };
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

  const yearProjectWorkingMatch =
    question.match(
      /(?:in\s+)?(20\d{2})\s+which\s+projects?\s+(.+?)\s+is\s+(?:working|work)(?:\s+on)?/i,
    ) ??
    question.match(
      /which\s+projects?\s+(.+?)\s+is\s+(?:working|work)(?:\s+on)?(?:\s+in\s+(20\d{2}))?/i,
    );
  if (yearProjectWorkingMatch) {
    const yearStr = yearProjectWorkingMatch[1]?.match(/^20\d{2}$/)
      ? yearProjectWorkingMatch[1]
      : yearProjectWorkingMatch[2];
    const personRaw = yearProjectWorkingMatch[1]?.match(/^20\d{2}$/)
      ? yearProjectWorkingMatch[2]
      : yearProjectWorkingMatch[1];
    const person = cleanPersonName(personRaw ?? "");
    if (person) {
      const year = yearStr ? Number.parseInt(yearStr, 10) : extractYearFromQuestion(question);
      return withYear(question, {
        kind: "activity_summary",
        personName: person,
        ...(year ? { year } : {}),
      });
    }
  }

  const whichPersonWorkingMatch =
    question.match(
      /which\s+projects?\s+(.+?)\s+is\s+(?:working|work)(?:\s+on)?\s+(?:currently|now)\b/i,
    ) ??
    question.match(
      /which\s+projects?\s+(?:is\s+)?(.+?)\s+(?:working|work)\s+on\s+(?:currently|now)\b/i,
    );
  if (whichPersonWorkingMatch?.[1]) {
    const person = cleanPersonName(whichPersonWorkingMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const whatPersonWorkingMatch =
    question.match(
      /what\s+projects?\s+(.+?)\s+is\s+(?:working|work)(?:\s+on)?\s+(?:currently|now)\b/i,
    ) ??
    question.match(
      /what\s+projects?\s+(?:is\s+)?(.+?)\s+(?:working|work)\s+on\s+(?:currently|now)\b/i,
    );
  if (whatPersonWorkingMatch?.[1]) {
    const person = cleanPersonName(whatPersonWorkingMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const whatIsPersonWorkingMatch = question.match(
    /\bwhat\s+(?:is|'s|are)\s+(.+?)\s+working\s+on\b/i,
  );
  if (whatIsPersonWorkingMatch?.[1]) {
    const person = cleanPersonName(whatIsPersonWorkingMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  if (
    !/\b(mostly|most|least|lowest|bottom)\s+active\b/i.test(q) &&
    !/\brecently\s+worked\b/i.test(q) &&
    !/\bworking\s+on\s+lately\b/i.test(q) &&
    !/\b(last|latest)\s+edited\b/i.test(q) &&
    !/\bcontributed\s+to\b/i.test(q)
  ) {
    return null;
  }

  const projectIsPersonMatch = question.match(
    /which\s+projects?\s+(?:is|are)\s+(.+?)\s+(?:mostly|most)\s+active(?:\s+in)?/i,
  );
  if (projectIsPersonMatch?.[1]) {
    const person = cleanPersonName(projectIsPersonMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const projectPersonMatch = question.match(
    /which\s+projects?\s+(.+?)\s+is\s+mostly\s+active/i,
  );
  if (projectPersonMatch?.[1]) {
    const person = cleanPersonName(projectPersonMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const personActiveInMatch = question.match(
    /^(.+?)\s+is\s+mostly\s+active(?:\s+in\s+(.+?))?(?:\?|$)/i,
  );
  if (personActiveInMatch?.[1]) {
    const person = cleanPersonName(personActiveInMatch[1]);
    if (person) {
      return withYear(question, {
        kind: "activity_summary",
        personName: person,
        docTitle: personActiveInMatch[2] ? stripDocWords(personActiveInMatch[2]) : undefined,
      });
    }
  }

  const latestWorkMatch = question.match(
    /(?:latest|most recent|last)\s+(?:task|tasks|project|projects|work)\s+(.+?)\s+(?:worked|work)\s+on/i,
  );
  if (latestWorkMatch?.[1]) {
    const person = cleanPersonName(latestWorkMatch[1]);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const personFromActiveMatch = extractAfter(question, [
    /(?:what|which)\s+projects?\s+(?:is|are)\s+(.+?)\s+(?:mostly|most)\s+active/i,
    /(?:for|by)\s+(.+?)\s+(?:recent|activity)/i,
  ]);
  if (personFromActiveMatch) {
    const person = cleanPersonName(personFromActiveMatch);
    if (person) {
      return withYear(question, { kind: "activity_summary", personName: person });
    }
  }

  const teamActiveMatch = question.match(
    /who\s+is\s+(?:the\s+)?(?:(?:most|mostly|least|lowest|bottom)\s+active)\s+(?:team\s+member|person|contributor|member)?\s*(?:in|on|for)\s+(.+?)(?:\?|$)/i,
  );
  if (teamActiveMatch?.[1]) {
    return {
      kind: "team_activity",
      docTitle: stripDocWords(teamActiveMatch[1]),
      raw: question,
    };
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

  if (
    /who\s+are\s+all\s+(?:the\s+)?(?:developers|devs|people|team\s+members)\b/i.test(q) ||
    /^(?:list|show)\s+(?:all\s+)?(?:developers|devs|people|team\s+members)\??$/i.test(q) ||
    /how\s+many\s+(?:total\s+)?(?:developers|devs|people|team\s+members|engineers|users)\b/i.test(q) ||
    /total\s+(?:number\s+of\s+)?(?:developers|devs|people|team\s+members|engineers|users)\b/i.test(q)
  ) {
    return { kind: "people_list", raw: question, parserConfidence: 0.95 };
  }

  if (/\bwhich\s+project\s+has\s+the\s+most\s+developers\b/i.test(q) || /\bprojects?\s+with\s+(?:the\s+)?most\s+devs\b/i.test(q)) {
    return { kind: "project_most_devs", raw: question, parserConfidence: 0.95 };
  }

  if (/\bwho\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\b/i.test(q)) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is|are)\s+(?:the\s+)?(?:project\s+)?(?:manager|lead|pm|owner)\s+(?:of|for|on)\s+(.+?)(?:\?|$)/i,
    ]);
    return { kind: "project_manager_of", docTitle: docTitle ?? undefined, raw: question };
  }

  // Implicit assigned list matching: "show assigned issues", "assigned tickets", "list assigned tasks", etc.
  if (
    /^(?:show|list|get|display|what are the)\s+assigned\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)(?:\?|$)/i.test(q) ||
    /\bassigned\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)(?:\?|$)/i.test(q)
  ) {
    return {
      kind: "assigned_list",
      raw: question,
      parserConfidence: 0.95,
    };
  }

  // "What tasks are assigned to X in Y project?" — person + project scoped
  // Must run BEFORE the year-only variant to capture the project in docTitle.
  const tasksAssignedToPersonInProjectMatch = question.match(
    /\b(?:which|what)\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:are\s+)?assigned\s+to\s+(.+?)\s+in\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
  );
  if (tasksAssignedToPersonInProjectMatch?.[1] && tasksAssignedToPersonInProjectMatch?.[2]) {
    const person = cleanPersonName(tasksAssignedToPersonInProjectMatch[1]);
    const project = stripDocWords(tasksAssignedToPersonInProjectMatch[2]);
    // Only use as person+project if the second group is not a year
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

  // "What tasks assigned to X (in 2024)?" — person only, optional year
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
  const showTasksMatch = q.match(/^(?:show|list|get|display)\s+(?:all\s+)?(?:the\s+)?(?:assigned\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:assigned\s+)?(?:to|for|of)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})/i)
    ?? q.match(/^(?:show|list|get|display)\s+(?:all\s+)?(?:the\s+)?([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})'s\s+(?:assigned\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?)/i);
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

  const activityQuery = parseActivityQuery(qn, q);
  if (activityQuery) return activityQuery;

  // "what is/are X working on?" / "what project(s) is/are X working on?" / "projects worked on by X"
  // "what is/are X working on?" / "what project(s) is/are X working on?" / "what task X is working on" / "X working on which task" / "X has worked on which task so far"
  const workingOnMatch = q.match(/\b(?:what|which)\s+(?:projects?|tasks?|work)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:is|are|has|have)\s+(?:currently\s+)?(?:been\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\b/i)
    ?? q.match(/\b(?:what|which)\s+(?:projects?|tasks?|work)\s+(?:is|are|has|have)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:currently\s+)?(?:been\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\b/i)
    ?? q.match(/\b([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:is|are|has|have)?\s*(?:currently\s+)?(?:working\s+on|assigned\s+to|works?\s+on)\s+(?:on\s+)?(?:which|what)\s+(?:tasks?|projects?|work)\b/i)
    ?? q.match(/\b([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2})\s+(?:has|have|had)\s+(?:been\s+)?(?:working\s+on|done|doing)\s+(?:on\s+)?(?:which|what)\s+(?:tasks?|projects?|work)\b/i)
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

  // Plan queries, e.g. "Mahendra's weekly plan", "plan for Mahendra", "what is Mahendra's monthly plan"
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

  // "Who is assigned to / working on ReportList?" — before broad assigned_list patterns
  if (
    /\bwho\s+(?:is\s+)?assigned\s+to\b/i.test(q) ||
    /\bwho\s+(?:is\s+)?working\s+on\b/i.test(q) ||
    /\bwho\s+works\s+on\b/i.test(q) ||
    /\bwho\s+are\s+all\s+(?:the\s+)?(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\b/i.test(q) ||
    /\b(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\b/i.test(q) ||
    /\bassignee\s+of\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /who\s+(?:is\s+)?assigned\s+to\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+(?:is\s+)?working\s+on\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+works\s+on\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /who\s+are\s+all\s+(?:the\s+)?(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:developers|devs|people|team\s+members)\s+(?:on|working\s+on|assigned\s+to)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /assignee\s+of\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (docTitle) {
      return { kind: "assigned_to_of", docTitle: stripDocWords(docTitle), raw: question, parserConfidence: 0.95 };
    }
  }

  // "assigned to [person] in/for [project]" — person + project
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

  const topicAssignedToPersonMatch = question.match(
    /^(?!who\s+(?:is\s+)?assigned\s+to)(?!what\s+(?:tasks?|issues?|tickets?|bugs?|work\s+items?)\s+(?:are\s+)?assigned\s+to)(?!which\s+project\s+.+\s+is\s+assigned)(?!what\s+project\s+.+\s+is\s+assigned)(?:only\s+one\s+|one\s+|single\s+)?(?:tasks?|issues?|tickets?|bugs?|work\s+items?|projects?|work|data|docs?|documents?|pages?)?\s*(?:of|for|in|on|about|related to)?\s*(.+?)\s+(?:assigned|assign|given)\s+to\s+(.+?)(?:\?|$)/i,
  );
  if (topicAssignedToPersonMatch?.[1] && topicAssignedToPersonMatch?.[2]) {
    return {
      kind: "assigned_list",
      docTitle: stripDocWords(topicAssignedToPersonMatch[1]),
      personName: cleanPersonName(topicAssignedToPersonMatch[2]) ?? undefined,
      raw: question,
      parserConfidence: 0.55,
      requiresLlmVerification: true,
    };
  }

  // owner list: "show all docs owned by X", "pages owned by souvik"
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



  if (
    /\b(?:what|which)\s+projects?\s+(?:is|are)\s+(.+?)\s+assigned\b/i.test(q) ||
    /\b(?:what|which)\s+projects?\s+(.+?)\s+is\s+assigned(?:\s+to)?\b/i.test(q) ||
    /\bwhat\s+projects?\s+(?:is|are)\s+(.+?)\s+assigned\s+to\b/i.test(q)
  ) {
    const assignedPersonMatch =
      question.match(/(?:what|which)\s+projects?\s+(?:is|are)\s+(.+?)\s+assigned(?:\s+to)?/i) ??
      question.match(/(?:what|which)\s+projects?\s+(.+?)\s+is\s+assigned(?:\s+to)?/i);
    if (assignedPersonMatch?.[1]) {
      const person = cleanPersonName(assignedPersonMatch[1]);
      if (person) {
        return { kind: "assigned_list", personName: person, raw: question, parserConfidence: 0.90 };
      }
    }
  }

  // worked-on list
  if (
    /\b(mostly|most)\s+active\b/i.test(q) ||
    /\b(?:give me|show|list|provide)?\s*(?:data|docs?|tasks?|projects?)?\s*(?:of|about|related to)?\s*\w+.*\bthat\s+\w+.*\b(worked|workd|working|works|work)\b/i.test(q) ||
    /\bwhat\s+(?:tasks?|projects?|work)\s+\w+\s+(?:works|work)\b/i.test(q) ||
    /\b(?:what|which|show|list|all)\b.*\b(tasks?|projects?|work)\b.*\b(?:assigned|assign|given)\b.*\bto\s+\w/i.test(q) ||
    /\bwhat\s+(?:tasks?|projects?|work)\s+.+?\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)\b/i.test(q) ||
    /\bwhat\s+.+?\s+(?:has|have)\s+(?:been\s+)?(?:worked|workd|working|done|doing)\s+(?:on\s+)?(?:tasks?|projects?|work)?\b/i.test(q) ||
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
      return withYear(question, {
        kind: "worked_on_list",
        docTitle: stripDocWords(topicTaskPersonMatch[1]),
        personName: cleanPersonName(topicTaskPersonMatch[2]) ?? undefined,
      });
    }

    const possessiveWorkedOnMatch = question.match(
      /(?:give me|show|list|provide)?\s*(?:\b(?:data|docs?|tasks?|projects?)\b)?\s*(?:of|about)?\s*(.+?)'s\s+(?:worked|workd|working|work|works)\s+(?:on\s+)?(.+?)(?:\?|$)/i,
    );
    if (possessiveWorkedOnMatch?.[1] && possessiveWorkedOnMatch?.[2]) {
      return withYear(question, {
        kind: "worked_on_list",
        personName: cleanPersonName(possessiveWorkedOnMatch[1]) ?? undefined,
        docTitle: stripDocWords(possessiveWorkedOnMatch[2]),
      });
    }

    const topicPersonMatch = question.match(
      /^(?:give me|show|list|provide)?\s*(?:\b(?:data|docs?|tasks?|projects?)\b)?\s*(?:of|about|related to)?\s*(.+?)\s+that\s+(.+?)\s+(?:has\s+been\s+|have\s+been\s+|is\s+|are\s+)?(?:worked|workd|working|works|work)(?:\s+on)?/i,
    );
    if (topicPersonMatch?.[1] && topicPersonMatch?.[2]) {
      return withYear(question, {
        kind: "worked_on_list",
        docTitle: stripDocWords(topicPersonMatch[1]),
        personName: cleanPersonName(topicPersonMatch[2]) ?? undefined,
      });
    }

    const personName = extractAfter(question, [
      /\b(?:on|about|for|of)\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s+(?:tasks?|projects?|work)\b/i,
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
    return withYear(question, { kind: "worked_on_list", personName: cleanPersonName(personName) ?? undefined });
  }

  // "Which project does Souvik own?" / "what projects does X own?"
  const personOwnsProjectsMatch = question.match(
    /\b(?:which|what)\s+projects?\s+(?:does|do)\s+(.+?)\s+own\b/i,
  );
  if (personOwnsProjectsMatch?.[1]) {
    const person = cleanPersonName(personOwnsProjectsMatch[1]);
    if (person) {
      return { kind: "owner_list", personName: person, raw: question };
    }
  }

  // "Which project is Souvik the owner of?" → list pages owned by person
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

  // blockers across workspace / project
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

  // ETA / completion date for a named project
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

  // project progress / status (before page_about — "what is the progress on Oscar" is NOT page_about)
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

  // summarize / purpose of a page (single doc, not a program)
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

  if (
    /\b(tell me about|explain|how does|how do|what is the)\b/i.test(q) &&
    /\b(policy|policies|leave|comp[- ]?off|approval\s+process|onboarding\s+(?:policy|flow|process)|workflow)\b/i.test(
      q,
    ) &&
    !/[—–].{8,}/.test(question)
  ) {
    const topicMatch = question.match(
      /(?:tell me about|explain|how does|how do|what is the)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    );
    const topic = topicMatch?.[1] ? stripDocWords(topicMatch[1]) : "";
    if (topic.length >= 4 && topic.length < 80) {
      return { kind: "semantic", docTitle: topic, raw: question };
    }
  }

  if (
    /\bwhat\s+does\b/i.test(q) &&
    /\b(hub|onboarding)\b/i.test(q)
  ) {
    const hubMatch = question.match(
      /\bwhat\s+does\s+(?:the\s+)?(.+?\bhub)\b/i,
    );
    const topic = hubMatch?.[1] ? stripDocWords(hubMatch[1]) || hubMatch[1].trim() : "";
    if (topic.length >= 8) {
      return { kind: "semantic", docTitle: topic, raw: question };
    }
  }

  // page details shortcut
  if (/\b(?:details|info|information)\s+(?:of|about|for|on)\s+(.+?)(?:\?|$)/i.test(q) || /^(?:show\s+)?(.+?)\s+(?:details|info|information)\??$/i.test(q)) {
    const match = question.match(/\b(?:details|info|information)\s+(?:of|about|for|on)\s+(.+?)(?:\?|$)/i) ?? question.match(/^(?:show\s+)?(.+?)\s+(?:details|info|information)\??$/i);
    const doc = stripDocWords(match?.[1] || "");
    if (doc) {
      return { kind: "page_about", docTitle: doc, raw: question, parserConfidence: 0.95 };
    }
  }

  // page overview ("tell me about X") — not progress/status/eta/blocker questions
  if (
    (/\b(tell me about|tell me more about|give me an overview of|overview of)\b/i.test(q) ||
      /\b(what is|what's|what are)\s+(?:the\s+)?(?!status\b)/i.test(q) ||
      /\b(describe|explain)\s+(?:the\s+)?/i.test(q)) &&
    !/\b(?:current\s+)?progress\b/i.test(q) &&
    !/\bprogress\s+on\b/i.test(q) &&
    !/\b(eta|blocker)\b/i.test(q) &&
    !/\brisks?\b/i.test(q) &&
    !/\bcompare\b/i.test(q) &&
    !/\bonboarding\s+tasks?\b/i.test(q) &&
    !/\bworking\s+on\b/i.test(q)
  ) {
    const docTitle = extractAfter(question, [
      /(?:tell me about|tell me more about|give me an overview of|overview of)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:what is|what's|what are)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
      /(?:describe|explain)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    ]);
    if (
      docTitle &&
      docTitle.length >= 4 &&
      looksLikeSinglePageTitle(docTitle) &&
      !/\b(status|type|kind)\s+of\b/i.test(q) &&
      !/\b(policy|policies|leave|comp[- ]?off|approval)\b/i.test(q)
    ) {
      return { kind: "page_about", docTitle, raw: question };
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

/** "summarize datapivot ai project", "overview of Oscar" — not single-page "tell me about X". */
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
