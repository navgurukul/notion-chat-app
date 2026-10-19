import type { ParsedQuery, QueryKind } from "@/lib/query/types";
import { isWeakProjectEtaAnswer } from "@/lib/sql/answers";

export function isTeamActivityMetadataGap(answer: string | null | undefined): boolean {
  return !!answer && /(?:do not list people|does not list people|not available from metadata alone|could not rank team activity)/i.test(answer);
}

export type QueryLane = "rag-only" | "sql-then-rag";

export interface QueryKindConfig {
  lane: QueryLane;
  trustedWhenSqlHits: boolean;
  needsPageTitleOnMiss?: boolean;
  shouldExpandRag?: boolean;
}

export const QUERY_KIND_CONFIG: Record<QueryKind, QueryKindConfig> = {
  // SQL is an accelerator: misses and untrusted hits continue through RAG.
  owner_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  owner_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  created_by_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  created_by_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  assigned_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  assigned_to_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  worked_on_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  project_manager_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  type_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  blocker_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  compare_pages: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  activity_summary: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  team_activity: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  team_roster: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  onboarding_tasks: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  risks_for: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: true },
  people_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  project_list: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  project_most_devs: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  project_member_breakdown: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  person_project_membership: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  assignee_project_check: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },

  // SQL-then-RAG hybrid lane
  status_of: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: true, shouldExpandRag: false },
  project_eta: { lane: "sql-then-rag", trustedWhenSqlHits: true, needsPageTitleOnMiss: false, shouldExpandRag: false },
  page_about: { lane: "sql-then-rag", trustedWhenSqlHits: false, needsPageTitleOnMiss: true, shouldExpandRag: true },
  project_summary: { lane: "sql-then-rag", trustedWhenSqlHits: false, needsPageTitleOnMiss: true, shouldExpandRag: true },
  topic_list: { lane: "sql-then-rag", trustedWhenSqlHits: false, needsPageTitleOnMiss: false, shouldExpandRag: true },
  analytics: { lane: "sql-then-rag", trustedWhenSqlHits: false, needsPageTitleOnMiss: false, shouldExpandRag: false },

  // RAG-only lane
  semantic: { lane: "rag-only", trustedWhenSqlHits: false, needsPageTitleOnMiss: false, shouldExpandRag: true },
  smalltalk: { lane: "rag-only", trustedWhenSqlHits: false, needsPageTitleOnMiss: false, shouldExpandRag: false },
};

export const STRUCTURED_QUERY_KINDS = new Set<QueryKind>(
  (Object.keys(QUERY_KIND_CONFIG) as QueryKind[]).filter((k) => Boolean(QUERY_KIND_CONFIG[k].needsPageTitleOnMiss))
);

export const TRUSTED_SQL_KINDS = new Set<QueryKind>(
  (Object.keys(QUERY_KIND_CONFIG) as QueryKind[]).filter((k) => QUERY_KIND_CONFIG[k].trustedWhenSqlHits)
);

export const BROAD_RAG_KINDS = new Set<QueryKind>(
  (Object.keys(QUERY_KIND_CONFIG) as QueryKind[]).filter((k) => Boolean(QUERY_KIND_CONFIG[k].shouldExpandRag))
);

export function getQueryKindConfig(kind: QueryKind): QueryKindConfig {
  return QUERY_KIND_CONFIG[kind] ?? { lane: "rag-only", trustedWhenSqlHits: false };
}

export function shouldExpandRagQuery(kind: QueryKind): boolean {
  return Boolean(getQueryKindConfig(kind).shouldExpandRag);
}

/** SQL response that is an explicit empty/miss (not a substantive metadata answer). */
export function isSqlMissAnswer(answer: string) {
  const trimmed = answer.trim();

  const looksLikeMiss =
    /^(?:no\b|could not\b|couldn't\b|i couldn't\b)/i.test(trimmed) &&
    trimmed.length < 400 &&
    !/^#{1,3}\s/m.test(trimmed) &&
    !/\]\(https?:/i.test(trimmed);
  if (looksLikeMiss) return true;

  return false;
}

/**
 * If true, skip SQL and use RAG + grounded LLM (retrieval-first fallback).
 * Goal: ~90% correct answers — only trust SQL when it clearly hit the right fact.
 */
export function shouldFallbackToRag(parsed: ParsedQuery, sqlAnswer: string | null): boolean {
  if (!sqlAnswer?.trim()) return true;
  if (isSqlMissAnswer(sqlAnswer)) return true;
  if (parsed.kind === "team_activity" && isTeamActivityMetadataGap(sqlAnswer)) return true;

  const config = getQueryKindConfig(parsed.kind);

  // A fuzzy page resolution can return metadata for the wrong similarly named page.
  if (
    config.needsPageTitleOnMiss &&
    parsed.resolvedEntities?.page?.value &&
    parsed.resolvedEntities.page.quality !== "EXACT" &&
    parsed.resolvedEntities.page.quality !== "PREFIX"
  ) {
    return true;
  }

  // RAG-only lane always uses RAG
  if (config.lane === "rag-only") return true;

  if (parsed.kind === "project_eta" && isWeakProjectEtaAnswer(sqlAnswer)) {
    return true;
  }

  if (
    (parsed.kind === "person_project_membership" || parsed.kind === "assignee_project_check") &&
    /^no\b/i.test(sqlAnswer.trim())
  ) {
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

  if (!config.trustedWhenSqlHits) {
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
