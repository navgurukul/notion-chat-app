import type { ParsedQuery, QueryKind } from "./types";

export enum RuleConfidence {
  HIGH = 0.90,
  MEDIUM = 0.60,
  LOW = 0.45
}

/** Intents that should stay on regex when extraction looks valid (deterministic SQL). */
const HIGH_PRECISION_KINDS = new Set<QueryKind>([
  "assigned_to_of",
  "status_of",
  "project_manager_of",
  "owner_of",
  "created_by_of",
  "type_of",
  "compare_pages",
  "onboarding_tasks",
  "blocker_list",
  "project_eta",
  "team_activity",
  "team_roster",
  "people_list",
  "analytics"
]);

const NEEDS_PERSON = new Set<QueryKind>([
  "owner_list",
  "created_by_list",
  "assigned_list",
  "worked_on_list",
  "activity_summary",
]);

const NEEDS_TITLE = new Set<QueryKind>([
  "owner_of",
  "created_by_of",
  "assigned_to_of",
  "project_manager_of",
  "topic_list",
  "type_of",
  "status_of",
  "page_about",
  "project_summary",
  "team_activity",
  "team_roster",
  "blocker_list",
  "project_eta",
  "risks_for",
]);

/**
 * Single source of truth for "this extracted entity looks like noise, not a
 * real name/title" — exported so resolve-query.ts's hasBrokenEntities can use
 * the same list instead of its own shorter, divergent copy.
 */
export const NOISY_ENTITY = /^(is|was|are|were|only|one|what|who|which|task|tasks|project|projects|work|manager|lead)$/i;

function entityQuality(parsed: Omit<ParsedQuery, "confidence" | "source">) {
  let score = 1;
  if (parsed.personName && (parsed.personName.length < 2 || NOISY_ENTITY.test(parsed.personName))) {
    score -= 0.45;
  }
  if (parsed.docTitle && (parsed.docTitle.length < 2 || NOISY_ENTITY.test(parsed.docTitle))) {
    score -= 0.45;
  }
  return Math.max(0, score);
}

/**
 * Heuristic confidence for regex routing — used to decide when to call the LLM classifier.
 * High-precision kinds with clean entities → ~0.90; broad catch-alls → lower.
 */
export function scoreRegexParse(
  parsed: Omit<ParsedQuery, "confidence" | "source">,
): number {
  const entity = entityQuality(parsed);

  if (parsed.parserConfidence !== undefined) {
    // FIX: previously `return parsed.parserConfidence` verbatim — a rule
    // branch that hardcodes parserConfidence: 0.95 kept that score even when
    // the entity it actually extracted (cleanPersonName/stripDocWords output)
    // looked like noise ("only", "manager", a stray fragment). That let a
    // confidently-wrong parse skip both entity-quality scoring below AND the
    // LLM-verification threshold in resolve-query.ts's shouldUseLlm (0.95
    // stays above the 0.75 cutoff regardless of entity quality). Scaling by
    // entity quality means a bad extraction still pulls the score down even
    // from a "trusted" branch, so shouldUseLlm can catch it.
    return parsed.parserConfidence * entity;
  }

  if (parsed.kind === "semantic") return 0.15;

  if (NEEDS_PERSON.has(parsed.kind) && !parsed.personName?.trim()) {
    return 0.05;
  }
  if (NEEDS_TITLE.has(parsed.kind) && !parsed.docTitle?.trim()) {
    return 0.05;
  }

  if (entity < 0.6) return 0.35;

  if (HIGH_PRECISION_KINDS.has(parsed.kind)) {
    const needsTitle = [
      "assigned_to_of",
      "status_of",
      "project_manager_of",
      "owner_of",
      "created_by_of",
      "type_of",
      "compare_pages",
      "project_eta",
      "team_activity",
      "team_roster",
    ].includes(parsed.kind);
    if (needsTitle && !parsed.docTitle?.trim()) return 0.4;
    if (parsed.kind === "compare_pages" && !parsed.compareTitleB?.trim()) return 0.4;
    return RuleConfidence.HIGH * entity;
  }

  if (parsed.kind === "assigned_list" && parsed.personName) return RuleConfidence.HIGH * entity;
  if (parsed.kind === "activity_summary" && parsed.personName) return RuleConfidence.HIGH * entity;
  if (parsed.kind === "page_about" && parsed.docTitle && parsed.docTitle.length >= 6) {
    return RuleConfidence.MEDIUM * entity;
  }
  if (parsed.kind === "project_summary" && parsed.docTitle) return RuleConfidence.MEDIUM * entity;
  if (parsed.kind === "risks_for" && parsed.docTitle) return RuleConfidence.MEDIUM * entity;

  if (parsed.kind === "worked_on_list" || parsed.kind === "topic_list") {
    return RuleConfidence.LOW * entity;
  }

  return RuleConfidence.MEDIUM * entity;
}

export function withRegexScores(
  parsed: Omit<ParsedQuery, "confidence" | "source">,
): ParsedQuery {
  return {
    ...parsed,
    confidence: scoreRegexParse(parsed),
    source: "regex",
  };
}