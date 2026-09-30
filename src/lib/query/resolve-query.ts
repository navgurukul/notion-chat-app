import { parseQueryByRules, withRegexScores, NOISY_ENTITY } from "@/lib/query/rules";
import { classifyQueryIntent, detectIntent, logQueryRouting } from "./intent";
import type { ParsedQuery } from "./types";
import type { ChatHistoryItem } from "@/lib/ai/openai";
import { tryFastPathRegexRoute, isAmbiguousQuery } from "@/lib/chat/smalltalk";
import {
  isNotionLinkRequest,
  shouldReformulate,
  reformulateSearchQuery,
} from "@/lib/chat/query-tools";
import {
  isFollowUpNeedingContext,
  getGenderOfPerson,
  hasGenuineFirstPersonReference,
} from "./entity-resolver";

// ─── Config ──────────────────────────────────────────────────────────────

export const HIGH_CONFIDENCE = 0.9;
export const PARSER_CONFIDENCE_THRESHOLD = 0.75;

const LLM_ENABLED = process.env.AI_INTENT_CLASSIFIER !== "false";
const LLM_TIMEOUT_MS = process.env.IS_EVALUATION === "true" ? 6000 : 2500;

// Regex intent hint -> which parsed kinds it supports, and the minimum
// confidence a supported kind is lifted to.
const INTENT_HINTS: Record<string, { kinds: ParsedQuery["kind"][]; floor: number }> = {
  PERSON_ACTIVITY: { kinds: ["activity_summary", "worked_on_list", "assigned_list"], floor: 0.86 },
  PERSON_OWNERSHIP: { kinds: ["owner_list", "owner_of", "project_manager_of"], floor: 0.82 },
  PROJECT_TEAM: { kinds: ["team_roster", "team_activity"], floor: 0.8 },
  PROJECT_SUMMARY: { kinds: ["project_summary", "page_about"], floor: 0.8 },
  PROJECT_STATUS: { kinds: ["status_of", "project_eta"], floor: 0.84 },
  ANALYTICS: {
    kinds: ["analytics", "project_most_devs", "project_member_breakdown", "people_list", "project_list"],
    floor: 0.84,
  },
  COMPARISON: { kinds: ["compare_pages"], floor: 0.88 },
};

const SMALLTALK_REGEX =
  /\b(not\s+)?feel(?:ing)?\s*well\b|\bhow\s+are\s+you\b|^(hi|hello|hey|thanks?|ok|okay)[\s!.,]*$|^(good\s+morning|good\s+afternoon|good\s+evening|goodbye|bye|greetings|hey\s+there|how's\s+it\s+going|what's\s+up)[\s!.,]*$|^(who\s+are\s+you|what\s+is\s+your\s+name|who\s+created\s+you|are\s+you\s+a\s+bot)[\s!.,?]*$/i;

const ANY_PRONOUN = /\b(he|him|his|she|her|hers|they|them|their|me|my|myself|i)\b/i;
const THIRD_PERSON_PRONOUN = /\b(he|him|his|she|her|hers|they|them|their)\b/i;
const PRONOUN_ONLY = /^(he|him|his|she|her|hers|they|them|their|me|my|myself|i)$/i;
const MALE_PRONOUN = /\b(he|him|his)\b/i;
const FEMALE_PRONOUN = /\b(she|her|hers)\b/i;

type LastEntities = {
  lastPerson?: string;
  lastProject?: string;
  lastMale?: string;
  lastFemale?: string;
};

// ─── Rules helpers ───────────────────────────────────────────────────────

function hasBrokenEntities(p: ParsedQuery) {
  return (
    (!!p.personName && NOISY_ENTITY.test(p.personName)) ||
    (!!p.docTitle && (NOISY_ENTITY.test(p.docTitle) || p.docTitle.length > 80))
  );
}

/** Regex parse, with confidence lifted when the intent hint agrees. */
function parseRules(question: string): ParsedQuery {
  const rules = withRegexScores(parseQueryByRules(question));
  const hint = INTENT_HINTS[detectIntent(question)];
  if (!hint || !hint.kinds.includes(rules.kind) || rules.confidence >= hint.floor) return rules;
  return { ...rules, confidence: hint.floor };
}

/** True when the regex result is too weak to trust without the LLM. */
function needsLlm(rules: ParsedQuery): boolean {
  if (!LLM_ENABLED) return false;
  return (
    rules.kind === "semantic" ||
    !!rules.requiresLlmVerification ||
    hasBrokenEntities(rules) ||
    (rules.parserConfidence !== undefined && rules.parserConfidence < PARSER_CONFIDENCE_THRESHOLD) ||
    rules.confidence < PARSER_CONFIDENCE_THRESHOLD
  );
}

/**
 * Combine regex and LLM results. Rules win only when they are highly
 * confident, entities are clean, and the LLM agrees (or is unsure).
 * Otherwise the LLM's kind wins when it is confident enough.
 */
function mergeRulesAndLlm(rules: ParsedQuery, llm: ParsedQuery): ParsedQuery {
  const smalltalk = llm.kind === "smalltalk" && llm.confidence >= 0.5;

  const rulesWin =
    !smalltalk &&
    rules.confidence >= HIGH_CONFIDENCE &&
    !hasBrokenEntities(rules) &&
    (rules.kind === llm.kind || llm.confidence < 0.5);

  if (rulesWin) {
    return {
      ...rules,
      source: "merged",
      confidence: Math.max(rules.confidence, llm.confidence * 0.5),
    };
  }

  const kind = smalltalk
    ? "smalltalk"
    : llm.confidence >= rules.confidence || llm.confidence >= 0.65
      ? llm.kind
      : rules.kind;

  return {
    kind,
    confidence: Math.max(llm.confidence, rules.confidence),
    source: "merged",
    personName: rules.personName,
    docTitle: rules.docTitle,
    compareTitleB: rules.compareTitleB,
    year: rules.year,
    dateRange: rules.dateRange,
    raw: rules.raw,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[resolveQuery] Intent classifier timeout after ${ms}ms. Falling back.`);
      resolve(fallback);
    }, ms);
    promise
      .then((res) => resolve(res))
      .catch(() => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}

// ─── Step 1: instant routes (no LLM, no DB) ──────────────────────────────

function instantRoute(question: string, history: ChatHistoryItem[]): ParsedQuery | null {
  const base = { confidence: 1.0, source: "regex", raw: question } as const;

  if (
    SMALLTALK_REGEX.test(question) ||
    tryFastPathRegexRoute(question) ||
    isAmbiguousQuery(question, history)
  ) {
    return { ...base, kind: "smalltalk" };
  }
  if (isNotionLinkRequest(question)) return { ...base, kind: "semantic" };
  return null;
}

// ─── Step 3: pick the person for pronouns / follow-ups ───────────────────

async function resolveFollowUpPerson(
  question: string,
  sessionName: string | undefined,
  last: LastEntities | undefined,
): Promise<string | undefined> {
  if (hasGenuineFirstPersonReference(question) && sessionName) return sessionName;

  const pickByGender = async (preferred: string | undefined, blocked: "male" | "female") => {
    if (preferred) return preferred;
    if (last?.lastPerson && (await getGenderOfPerson(last.lastPerson)) !== blocked) {
      return last.lastPerson;
    }
    return undefined;
  };

  if (MALE_PRONOUN.test(question)) return pickByGender(last?.lastMale, "female");
  if (FEMALE_PRONOUN.test(question)) return pickByGender(last?.lastFemale, "male");
  return last?.lastPerson;
}

// ─── Main entry ──────────────────────────────────────────────────────────

/**
 * Flow: instant routes -> (reformulate + regex rules, LLM only if rules are
 * weak) -> fill person/doc from reformulation and conversation context.
 */
export async function resolveQuery(
  question: string,
  history: ChatHistoryItem[] = [],
  sessionName?: string,
  lastEntities?: LastEntities,
): Promise<ParsedQuery> {
  // 1. Instant routes
  const instant = instantRoute(question, history);
  if (instant) return instant;

  // 2. Start reformulation and (if the raw question looks weak) the LLM
  //    classifier together, so follow-ups pay max(a, b) instead of a + b.
  //    The early classifier sees the raw question, not the reformulated one.
  const reformulating = shouldReformulate(question, history);
  const reformulationPromise = reformulating ? reformulateSearchQuery(question, history) : null;

  const rawRules = parseRules(question);
  const earlyLlmPromise = needsLlm(rawRules) ? classifyQueryIntent(question) : null;

  let processedQuestion = question;
  let reformulatedText: string | undefined;
  let rulesInput = question;

  if (reformulationPromise) {
    const reformulated = await reformulationPromise;
    processedQuestion = reformulated.searchQuery;
    reformulatedText = reformulated.searchQuery;
    // Only trust an LLM rewrite as regex input when it did not swap out a pronoun.
    if (reformulated.method === "llm" && !ANY_PRONOUN.test(question)) {
      rulesInput = reformulated.searchQuery;
    }
  }

  const rules = rulesInput === question ? rawRules : parseRules(rulesInput);

  // 3. Use the LLM only when the rules are not confident
  let parsed = rules;
  let usedLlm = false;
  if (needsLlm(rules)) {
    usedLlm = true;
    const llm = await withTimeout(
      earlyLlmPromise ?? classifyQueryIntent(processedQuestion),
      LLM_TIMEOUT_MS,
      null,
    );
    if (llm) parsed = mergeRulesAndLlm(rules, llm);
  }

  // 4. Fill missing doc/person from the reformulated text
  let docTitle = parsed.docTitle;
  let personName = parsed.personName;

  if (reformulatedText) {
    const ref = parseQueryByRules(reformulatedText);
    if (!docTitle && ref.docTitle) docTitle = ref.docTitle;

    const originalHasPronoun =
      THIRD_PERSON_PRONOUN.test(question) || hasGenuineFirstPersonReference(question);
    if (!personName && ref.personName && !originalHasPronoun) personName = ref.personName;
  }

  if (personName && PRONOUN_ONLY.test(personName)) personName = undefined;

  // 5. Fill person from the conversation ("he", "my", "what about that?")
  if (!personName && isFollowUpNeedingContext(question, history)) {
    personName = await resolveFollowUpPerson(question, sessionName, lastEntities);
  }

  const result: ParsedQuery = {
    ...parsed,
    ...(docTitle ? { docTitle } : {}),
    personName: personName || parsed.personName,
    raw: question,
    reformulatedQuery: reformulatedText,
    lowConfidence: parsed.confidence < 0.6,
  };

  logQueryRouting(question, rules, result, usedLlm);
  return result;
}

export function resolveQueryRulesOnly(question: string): ParsedQuery {
  return withRegexScores(parseQueryByRules(question));
}