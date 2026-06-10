import { parseQueryByRules } from "@/lib/query/rules";
import { classifyQueryIntent } from "./intent-classifier";
import { detectIntent } from "./intent";
import { resolveEntities } from "./entity-resolution";
import { logQueryRouting } from "./telemetry";
import type { ParsedQuery } from "./types";
import { withRegexScores } from "./rule-confidence";

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
/** Regex wins above this when entities look valid */
const REGEX_OVERRIDE = 0.9;
/** Use LLM when regex confidence is below this */
const LLM_THRESHOLD = 0.78;

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
  if (hasBrokenEntities(rules)) return true;
  if (rules.confidence < LLM_THRESHOLD) return true;
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
  if (rules.confidence >= REGEX_OVERRIDE && !hasBrokenEntities(rules)) {
    return { ...rules, source: "merged", confidence: Math.max(rules.confidence, llm.confidence * 0.5) };
  }

  if (llm.confidence >= 0.72) {
    return llm;
  }

  if (rules.kind !== "semantic" && rules.confidence >= llm.confidence) {
    return rules;
  }

  return {
    ...llm,
    source: "merged",
    confidence: Math.max(llm.confidence, rules.confidence),
  };
}

/**
 * Hybrid router: deterministic regex first, LLM intent when confidence is low or semantic.
 * This is the single entry point the chat API should use.
 */
export async function resolveQuery(question: string): Promise<ParsedQuery> {
  const rules = applyIntentHint(question, withRegexScores(parseQueryByRules(question)));

  if (!shouldUseLlm(rules)) {
    return finalizeQuery(question, rules, rules, false);
  }

  const llm = await classifyQueryIntent(question);
  if (!llm) {
    return finalizeQuery(question, rules, rules, true);
  }

  return finalizeQuery(question, mergeRulesAndLlm(rules, llm), rules, true);
}

async function finalizeQuery(question: string, parsed: ParsedQuery, rules: ParsedQuery, usedLlm: boolean) {
  const withEntities = await resolveEntities(parsed);
  logQueryRouting(question, rules, withEntities, usedLlm);
  return withEntities;
}

/** Sync regex-only parse (tests, offline scripts). Skips LLM and entity resolution. */
export function resolveQueryRulesOnly(question: string): ParsedQuery {
  return withRegexScores(parseQueryByRules(question));
}
