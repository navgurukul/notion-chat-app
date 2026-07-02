import { parseQueryByRules } from "@/lib/query/rules";
import { classifyQueryIntent } from "./intent-classifier";
import { detectIntent } from "./intent";
import { logQueryRouting } from "./telemetry";
import type { ParsedQuery } from "./types";
import { withRegexScores } from "./rule-confidence";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { tryFastPathRegexRoute } from "@/lib/chat/pipeline/router";
import { isNotionLinkRequest } from "@/lib/chat/link-lookup";
import { shouldReformulate, reformulateSearchQuery } from "@/lib/chat/query-reformulation";

const INTENT_KIND_HINTS: Record<string, Set<ParsedQuery["kind"]>> = {
  PERSON_ACTIVITY: new Set(["activity_summary", "worked_on_list", "assigned_list"]),
  PERSON_OWNERSHIP: new Set(["owner_list", "owner_of", "project_manager_of"]),
  PROJECT_TEAM: new Set(["team_roster", "team_activity"]),
  PROJECT_SUMMARY: new Set(["project_summary", "page_about"]),
  PROJECT_STATUS: new Set(["status_of", "project_eta"]),
  UNKNOWN: new Set(),
};

const INTENT_CONFIDENCE_FLOORS: Record<string, number> = {
  PERSON_ACTIVITY: 0.86,
  PERSON_OWNERSHIP: 0.82,
  PROJECT_TEAM: 0.8,
  PROJECT_SUMMARY: 0.8,
  PROJECT_STATUS: 0.84,
  UNKNOWN: 0,
};

const LLM_ENABLED = process.env.AI_INTENT_CLASSIFIER !== "false";
export const HIGH_CONFIDENCE = 0.90;
export const PARSER_CONFIDENCE_THRESHOLD = 0.75;

function hasBrokenEntities(parsed: ParsedQuery) {
  const noisy = /^(is|was|are|were|only|one|what|who|which)$/i;
  if (parsed.personName && noisy.test(parsed.personName)) return true;
  if (parsed.docTitle && noisy.test(parsed.docTitle)) return true;
  if (parsed.docTitle && parsed.docTitle.length > 80) return true;
  return false;
}

function shouldUseLlm(rules: ParsedQuery): boolean {
  if (!LLM_ENABLED) return false;
  if (rules.kind === "semantic") return true;
  if (rules.requiresLlmVerification) return true;
  if (hasBrokenEntities(rules)) return true;
  if (rules.parserConfidence !== undefined && rules.parserConfidence < PARSER_CONFIDENCE_THRESHOLD) return true;
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

function mergeRulesAndLlm(rules: ParsedQuery, llm: ParsedQuery): ParsedQuery {
  if (rules.confidence >= HIGH_CONFIDENCE && !hasBrokenEntities(rules)) {
    return { 
      ...rules, 
      source: "merged", 
      confidence: Math.max(rules.confidence, llm.confidence * 0.5) 
    };
  }

  const mergedKind = (llm.confidence >= 0.72) ? llm.kind : rules.kind;
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
    raw: rules.raw
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[resolveQuery] Intent classifier timeout after ${timeoutMs}ms. Falling back.`);
      resolve(fallback);
    }, timeoutMs);
    promise.then((res) => {
      clearTimeout(timer);
      resolve(res);
    }).catch(() => {
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
  lastEntities?: { lastPerson?: string; lastProject?: string }
): Promise<ParsedQuery> {
  // 1. Fast-path regex checks (greetings/thanks/bye/link)
  const fastPath = tryFastPathRegexRoute(question);
  if (fastPath) {
    return { kind: "smalltalk", confidence: 1.0, source: "regex", raw: question };
  }
  if (isNotionLinkRequest(question)) {
    return { kind: "semantic", confidence: 1.0, source: "regex", raw: question };
  }

  // 1.5 Early Query Reformulation for follow-up turns
  let processedQuestion = question;
  let reformulatedQueryText: string | undefined;
  if (shouldReformulate(question, history)) {
    const reformulated = await reformulateSearchQuery(question, history);
    processedQuestion = reformulated.searchQuery;
    reformulatedQueryText = reformulated.searchQuery;
  }

  // 2. Regex rules parsing on the processed question
  const rules = applyIntentHint(processedQuestion, withRegexScores(parseQueryByRules(processedQuestion)));

  let parsed: ParsedQuery;
  let usedLlm = false;

  // 3. Skip LLM if rules are confident
  if (!shouldUseLlm(rules)) {
    parsed = rules;
  } else {
    usedLlm = true;
    const llmPromise = classifyQueryIntent(processedQuestion);
    const timeoutLimit = process.env.IS_EVALUATION === "true" ? 6000 : 2500;
    const llm = await withTimeout(llmPromise, timeoutLimit, null);
    if (!llm) {
      parsed = rules;
    } else {
      parsed = mergeRulesAndLlm(rules, llm);
    }
  }

  const finalParsed: ParsedQuery = {
    ...parsed,
    raw: question,
    reformulatedQuery: reformulatedQueryText
  };

  logQueryRouting(question, rules, finalParsed, usedLlm);
  return finalParsed;
}

export function resolveQueryRulesOnly(question: string): ParsedQuery {
  return withRegexScores(parseQueryByRules(question));
}
