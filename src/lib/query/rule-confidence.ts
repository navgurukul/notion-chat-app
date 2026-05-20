import type { ParsedQuery, QueryKind } from "./types";

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
]);

const NOISY_ENTITY = /^(is|was|are|were|only|one|what|who|which|task|tasks|project|projects|work|manager|lead)$/i;

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
 * High-precision kinds with clean entities → ~0.95; broad catch-alls → lower.
 */
export function scoreRegexParse(
  parsed: Omit<ParsedQuery, "confidence" | "source">,
): number {
  if (parsed.kind === "semantic") return 0.15;

  const entity = entityQuality(parsed);
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
    ].includes(parsed.kind);
    const needsPerson = false;
    if (needsTitle && !parsed.docTitle?.trim()) return 0.4;
    if (parsed.kind === "compare_pages" && !parsed.compareTitleB?.trim()) return 0.4;
    if (needsPerson) return 0.4;
    return 0.95 * entity;
  }

  if (parsed.kind === "assigned_list" && parsed.personName) return 0.88 * entity;
  if (parsed.kind === "activity_summary" && parsed.personName) return 0.82 * entity;
  if (parsed.kind === "page_about" && parsed.docTitle && parsed.docTitle.length >= 6) {
    return 0.8 * entity;
  }
  if (parsed.kind === "project_summary" && parsed.docTitle) return 0.78 * entity;
  if (parsed.kind === "risks_for" && parsed.docTitle) return 0.75 * entity;

  if (parsed.kind === "worked_on_list" || parsed.kind === "topic_list") {
    return 0.55 * entity;
  }

  return 0.65 * entity;
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
