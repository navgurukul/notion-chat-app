import type { QueryKind } from "@/lib/query/types";

export const MAX_MESSAGE_LENGTH = 2000;

/** SQL-backed intents that need a page title when lookup returns nothing. */
export const STRUCTURED_QUERY_KINDS = new Set<QueryKind>([
  "page_about",
  "project_summary",
  "compare_pages",
  "risks_for",
  "onboarding_tasks",
  "owner_of",
  "created_by_of",
  "assigned_to_of",
  "type_of",
  "status_of",
]);
