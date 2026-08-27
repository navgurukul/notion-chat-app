import { parseQueryByRules } from "@/lib/query/rules";
import { classifyQueryIntent } from "./intent-classifier";
import { detectIntent } from "./intent";
import { logQueryRouting } from "./telemetry";
import type { ParsedQuery } from "./types";
import { withRegexScores, NOISY_ENTITY } from "./rule-confidence";
import type { ChatHistoryItem } from "@/lib/ai/openai";
import {
  tryFastPathRegexRoute,
  isAmbiguousQuery,
} from "@/lib/chat/pipeline/router";
import {
  isNotionLinkRequest,
  shouldReformulate,
  reformulateSearchQuery,
} from "@/lib/chat/query-tools";
import { isFollowUpNeedingContext } from "./entity-resolver";
import { getGenderOfPerson } from "./entity-resolver/person";

const INTENT_KIND_HINTS: Record<string, Set<ParsedQuery["kind"]>> = {
  PERSON_ACTIVITY: new Set([
    "activity_summary",
    "worked_on_list",
    "assigned_list",
  ]),
  PERSON_OWNERSHIP: new Set(["owner_list", "owner_of", "project_manager_of"]),
  PROJECT_TEAM: new Set(["team_roster", "team_activity"]),
  PROJECT_SUMMARY: new Set(["project_summary", "page_about"]),
  PROJECT_STATUS: new Set(["status_of", "project_eta"]),
  ANALYTICS: new Set(["analytics", "project_most_devs", "project_member_breakdown", "people_list"]),
  COMPARISON: new Set(["compare_pages"]),
  UNKNOWN: new Set(),
};

const INTENT_CONFIDENCE_FLOORS: Record<string, number> = {
  PERSON_ACTIVITY: 0.86,
  PERSON_OWNERSHIP: 0.82,
  PROJECT_TEAM: 0.8,
  PROJECT_SUMMARY: 0.8,
  PROJECT_STATUS: 0.84,
  ANALYTICS: 0.84,
  COMPARISON: 0.88,
  UNKNOWN: 0,
};

const LLM_ENABLED = process.env.AI_INTENT_CLASSIFIER !== "false";
export const HIGH_CONFIDENCE = 0.9;
export const PARSER_CONFIDENCE_THRESHOLD = 0.75;

/**
 * FIX: previously used its own shorter, diverging noisy-entity regex
 * (`/^(is|was|are|were|only|one|what|who|which)$/i`) that disagreed with
 * rule-confidence.ts's NOISY_ENTITY. An entity like "manager" or "project"
 * would fail rule-confidence.ts's entityQuality() check (correctly) but pass
 * this function's old shorter check (incorrectly) — so whether a bad entity
 * got flagged for LLM re-verification depended on which of the two
 * divergent copies ran, not on any real distinction. Both now use the same
 * source of truth.
 */
function hasBrokenEntities(parsed: ParsedQuery) {
  if (parsed.personName && NOISY_ENTITY.test(parsed.personName)) return true;
  if (parsed.docTitle && NOISY_ENTITY.test(parsed.docTitle)) return true;
  if (parsed.docTitle && parsed.docTitle.length > 80) return true;
  return false;
}

function shouldUseLlm(rules: ParsedQuery): boolean {
  if (!LLM_ENABLED) return false;
  if (rules.kind === "semantic") return true;
  if (rules.requiresLlmVerification) return true;
  if (hasBrokenEntities(rules)) return true;
  if (
    rules.parserConfidence !== undefined &&
    rules.parserConfidence < PARSER_CONFIDENCE_THRESHOLD
  )
    return true;
  if (rules.confidence < PARSER_CONFIDENCE_THRESHOLD) return true;
  return false;
}

function applyIntentHint(question: string, rules: ParsedQuery): ParsedQuery {
  const intent = detectIntent(question);
  const hintedKinds = INTENT_KIND_HINTS[intent];
  if (!hintedKinds?.has(rules.kind)) return rules;

  const floor = INTENT_CONFIDENCE_FLOORS[intent] ?? 0;
  if (rules.confidence >= floor) return rules;

  return {
    ...rules,
    confidence: floor,
  };
}

/**
 * FIX: previously, when `rules.confidence >= HIGH_CONFIDENCE` (0.9), this
 * returned `{ ...rules, source: "merged", confidence: max(rules.confidence,
 * llm.confidence * 0.5) }` — it kept `rules.kind` UNCONDITIONALLY and only
 * ever blended the LLM's confidence NUMBER in. The LLM's classified `kind`
 * was computed but never used in that branch, so a confidently-wrong regex
 * rule could never be corrected even when the LLM disagreed with high
 * confidence of its own. Now rules only win outright when the LLM agrees,
 * or is clearly less confident than the rules parser.
 *
 * NOTE: this changes routing behavior — test against your eval set / query
 * log before shipping. The threshold below (`llm.confidence < rules.confidence
 * - 0.1`) is a starting point, not a guarantee.
 */
function mergeRulesAndLlm(rules: ParsedQuery, llm: ParsedQuery): ParsedQuery {
  const smalltalkOverride = llm.kind === "smalltalk" && llm.confidence >= 0.5;

  const rulesWinsOutright =
    !smalltalkOverride &&
    rules.confidence >= HIGH_CONFIDENCE &&
    !hasBrokenEntities(rules) &&
    (rules.kind === llm.kind || llm.confidence < rules.confidence - 0.1);

  if (rulesWinsOutright) {
    return {
      ...rules,
      source: "merged",
      confidence: Math.max(rules.confidence, llm.confidence * 0.5),
    };
  }

  const mergedKind = smalltalkOverride
    ? "smalltalk"
    : llm.confidence >= rules.confidence || llm.confidence >= 0.72
      ? llm.kind
      : rules.kind;
  const confidence = Math.max(llm.confidence, rules.confidence);

  return {
    kind: mergedKind,
    confidence,
    source: "merged",
    personName: rules.personName,
    docTitle: rules.docTitle,
    compareTitleB: rules.compareTitleB,
    year: rules.year,
    dateRange: rules.dateRange,
    raw: rules.raw,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[resolveQuery] Intent classifier timeout after ${timeoutMs}ms. Falling back.`,
      );
      resolve(fallback);
    }, timeoutMs);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

/**
 * Hybrid router: runs fast deterministic checks first (greeting/thanks/link),
 * then regex rules on raw query, and calls LLM classifier with a 1500ms timeout
 * only when confidence is low. Does not perform DB entity resolution upfront.
 */
export async function resolveQuery(
  question: string,
  history: ChatHistoryItem[] = [],
  sessionName?: string,
  lastEntities?: { lastPerson?: string; lastProject?: string; lastMale?: string; lastFemale?: string },
): Promise<ParsedQuery> {
  // 1. Fast-path regex checks (greetings/thanks/bye/link)
  const fastPath = tryFastPathRegexRoute(question);

  const SMALLTALK_HEURISTIC =
    /\b(not\s+)?feel(?:ing)?\s*well\b|\bhow\s+are\s+you\b|^(hi|hello|hey|thanks?|ok|okay)[\s!.,]*$|^(good\s+morning|good\s+afternoon|good\s+evening|goodbye|bye|greetings|hey\s+there|how's\s+it\s+going|what's\s+up)[\s!.,]*$|^(who\s+are\s+you|what\s+is\s+your\s+name|who\s+created\s+you|are\s+you\s+a\s+bot)[\s!.,?]*$/i;

  if (SMALLTALK_HEURISTIC.test(question)) {
    return {
      kind: "smalltalk",
      confidence: 1.0,
      source: "regex",
      raw: question,
    };
  }

  if (fastPath) {
    return {
      kind: "smalltalk",
      confidence: 1.0,
      source: "regex",
      raw: question,
    };
  }
  if (isAmbiguousQuery(question, history)) {
    return {
      kind: "smalltalk",
      confidence: 1.0,
      source: "regex",
      raw: question,
    };
  }
  if (isNotionLinkRequest(question)) {
    return {
      kind: "semantic",
      confidence: 1.0,
      source: "regex",
      raw: question,
    };
  }

  // 1.5 Early Query Reformulation check
  const needsReformulation = shouldReformulate(question, history);

  // 2. Regex rules parsing on the original question first
  const rules = applyIntentHint(
    question,
    withRegexScores(parseQueryByRules(question)),
  );

  let parsed: ParsedQuery;
  let usedLlm = false;
  const needsLlm = shouldUseLlm(rules);

  let reformulatedQueryText: string | undefined;
  let rulesInputQuestion = question;

  if (needsReformulation || needsLlm) {
    const timeoutLimit = process.env.IS_EVALUATION === "true" ? 6000 : 2500;
    const [reformulated, llm] = await Promise.all([
      needsReformulation
        ? reformulateSearchQuery(question, history)
        : Promise.resolve(null),
      needsLlm
        ? withTimeout(classifyQueryIntent(question), timeoutLimit, null)
        : Promise.resolve(null),
    ]);

    if (reformulated) {
      reformulatedQueryText = reformulated.searchQuery;
      const hasPersonPronoun = /\b(he|him|his|she|her|hers|they|them|their|me|my|myself|i)\b/i.test(question);
      if (reformulated.method === "llm" && !hasPersonPronoun) {
        rulesInputQuestion = reformulated.searchQuery;
        // Re-parse rules on the rules-safe reformulated question
        const updatedRules = applyIntentHint(
          rulesInputQuestion,
          withRegexScores(parseQueryByRules(rulesInputQuestion)),
        );
        if (llm) {
          usedLlm = true;
          parsed = mergeRulesAndLlm(updatedRules, llm);
        } else {
          parsed = updatedRules;
        }
      } else {
        if (llm) {
          usedLlm = true;
          parsed = mergeRulesAndLlm(rules, llm);
        } else {
          parsed = rules;
        }
      }
    } else {
      if (llm) {
        usedLlm = true;
        parsed = mergeRulesAndLlm(rules, llm);
      } else {
        parsed = rules;
      }
    }
  } else {
    parsed = rules;
  }

  let docTitle = parsed.docTitle;
  let personName = parsed.personName;
  if (reformulatedQueryText) {
    const refRules = parseQueryByRules(reformulatedQueryText);
    if (!docTitle && refRules.docTitle) {
      docTitle = refRules.docTitle;
    }
    const originalHasPronoun = /\b(he|him|his|she|her|hers|they|them|their|me|my|myself|i)\b/i.test(question);
    if (!personName && refRules.personName && !originalHasPronoun) {
      personName = refRules.personName;
    }
  }

  if (personName && /^(he|him|his|she|her|hers|they|them|their|me|my|myself|i)$/i.test(personName)) {
    personName = undefined;
  }

  if (!personName && isFollowUpNeedingContext(question, history)) {
    const hasFirstPerson = /\b(my|me|myself|i)\b/i.test(question);
    const hasMalePronoun = /\b(he|him|his)\b/i.test(question);
    const hasFemalePronoun = /\b(she|her|hers)\b/i.test(question);
    if (hasFirstPerson && sessionName) {
      personName = sessionName;
    } else if (hasMalePronoun) {
      personName = lastEntities?.lastMale;
      if (!personName && lastEntities?.lastPerson && (await getGenderOfPerson(lastEntities.lastPerson)) !== "female") {
        personName = lastEntities.lastPerson;
      }
    } else if (hasFemalePronoun) {
      personName = lastEntities?.lastFemale;
      if (!personName && lastEntities?.lastPerson && (await getGenderOfPerson(lastEntities.lastPerson)) !== "male") {
        personName = lastEntities.lastPerson;
      }
    } else {
      personName = lastEntities?.lastPerson;
    }
  }

  const finalParsed: ParsedQuery = {
    ...parsed,
    ...(docTitle ? { docTitle } : {}),
    personName: personName || parsed.personName,
    raw: question,
    reformulatedQuery: reformulatedQueryText,
  };

  logQueryRouting(question, rules, finalParsed, usedLlm);
  return finalParsed;
}

export function resolveQueryRulesOnly(question: string): ParsedQuery {
  return withRegexScores(parseQueryByRules(question));
}