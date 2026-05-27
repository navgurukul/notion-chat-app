import type { ParsedQuery } from "@/lib/query/types";
import { isMetadataOnlyKind } from "@/lib/chat/routing-policy";
import { isWeakProjectEtaAnswer } from "@/lib/sql/answers";

/** SQL response that is an explicit empty/miss (not a substantive metadata answer). */
export function isSqlMissAnswer(answer: string) {
  const trimmed = answer.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower.includes("couldn't find") ||
    lower.includes("not found in synced") ||
    lower.includes("i couldn't find") ||
    lower.startsWith("no matching result")
  ) {
    return true;
  }

  // Structured SQL answers (## / ###) may mention Sync changes as a footnote — not a miss.
  if (/^#{2,3}\s+/m.test(trimmed) && trimmed.length > 180) return false;

  return false;
}

/** SQL could not rank team activity from Owner / Last edited by — hybrid RAG may help. */
export function isTeamActivityMetadataGap(answer: string | null | undefined) {
  return Boolean(answer?.includes("not available from metadata alone"));
}

/** SQL paths that are reliable when they return a concrete fact (not “not found”). */
const TRUSTED_SQL_KINDS = new Set([
  "owner_of",
  "status_of",
  "assigned_to_of",
  "created_by_of",
  "type_of",
  "blocker_list",
  "compare_pages",
  "assigned_list",
  "owner_list",
  "created_by_list",
  "worked_on_list",
  "activity_summary",
  "project_eta",
  "team_activity",
  "project_manager_of",
  "risks_for",
  "onboarding_tasks",
]);

/**
 * If true, skip SQL and use RAG + grounded LLM (retrieval-first fallback).
 * Goal: ~90% correct answers — only trust SQL when it clearly hit the right fact.
 */
export function shouldFallbackToRag(parsed: ParsedQuery, sqlAnswer: string | null): boolean {
  if (!sqlAnswer?.trim()) return true;
  if (isSqlMissAnswer(sqlAnswer)) return true;

  // Metadata lane (status, blockers, team activity, …) must not be discarded for RAG.
  if (isMetadataOnlyKind(parsed.kind)) return false;

  if (parsed.kind === "project_eta" && isWeakProjectEtaAnswer(sqlAnswer)) {
    return true;
  }

  // Mis-routed person questions parsed as page titles
  if (parsed.kind === "page_about" && /\bworking\s+on\b/i.test(parsed.docTitle ?? "")) {
    return true;
  }

  if (parsed.kind === "page_about") {
    if (/\bpages matching\b/i.test(sqlAnswer)) return true;
    return false;
  }

  if (parsed.kind === "project_summary" || parsed.kind === "topic_list") {
    return true;
  }

  if (!TRUSTED_SQL_KINDS.has(parsed.kind)) {
    return true;
  }

  if (parsed.kind === "compare_pages" && /not found in synced/i.test(sqlAnswer)) {
    return true;
  }

  if (
    (parsed.kind === "assigned_list" || parsed.kind === "activity_summary") &&
    parsed.personName &&
    sqlAnswer.length < 120
  ) {
    return true;
  }

  return false;
}
