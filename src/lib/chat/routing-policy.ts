import type { ParsedQuery, QueryKind } from "@/lib/query/types";
import { isWeakProjectEtaAnswer } from "@/lib/sql/answers";

// ---------------------------------------------------------------------------
// Metadata-only routing (SQL-only lane; never silently fall back to RAG)
// ---------------------------------------------------------------------------

/**
 * Metadata intents: SQL-only lane. Never silently fall back to RAG.
 * (Link requests use tryNotionLinkAnswer separately.)
 */
export const METADATA_ONLY_KINDS = new Set<QueryKind>([
  "owner_of",
  "owner_list",
  "created_by_of",
  "created_by_list",
  "assigned_to_of",
  "assigned_list",
  "worked_on_list",
  // "status_of",
  "type_of",
  "blocker_list",
  "compare_pages",
  "project_manager_of",
  "activity_summary",
  "team_activity",
  "team_roster",
  "onboarding_tasks",
  "risks_for",
  "people_list",
  "project_most_devs",
  "project_member_breakdown",
  "person_project_membership",
  "assignee_project_check",
]);

export function isMetadataOnlyKind(kind: QueryKind): boolean {
  return METADATA_ONLY_KINDS.has(kind);
}

export function metadataNotFoundAnswer(parsed: ParsedQuery): string {
  const person = parsed.personName?.trim();
  const title = parsed.docTitle?.trim();

  switch (parsed.kind) {
    case "owner_list":
      return person
        ? `No synced Notion pages list **${person}** as owner. Check the exact name spelling in Notion, or use **Sync changes** if ownership was updated recently.`
        : "No owner could be resolved — include a person name, e.g. **Which project does Souvik own?**";
    case "owner_of":
      return title
        ? `No synced Notion page matched **${title}** for an owner lookup. Use the exact page title from Notion or **Sync changes**.`
        : "I couldn't find a project or page title to look up.";
    case "assigned_list":
      return person
        ? `No tasks or pages found assigned to **${person}** in synced Notion data. Try **Sync changes** or rephrase with a year, e.g. tasks assigned to Tamanna in 2025.`
        : "No assignee name found in the question.";
    case "assigned_to_of":
      return title
        ? `No assignee found for **${title}** in synced Notion data. Use **Sync changes** if assignments changed recently.`
        : "I couldn't find a task or page name to look up.";
    // case "status_of":
    //   return title
    //     ? `No synced Notion pages matched **${title}** for status. Try the exact project/page name or **Sync changes**.`
    //     : "No page or project name found for status lookup.";
    case "blocker_list":
      return "No blockers matched your filters in synced Notion data. Try narrowing by project name or use **Sync changes**.";
    case "compare_pages":
      return "Could not find both pages to compare in synced Notion data. Use exact titles and **Sync changes** if needed.";
    case "activity_summary":
      return person
        ? `No activity or project assignment data found for **${person}** in synced Notion. Check name spelling or **Sync changes**.`
        : "No person name found for activity lookup.";
    case "team_activity":
      return title
        ? `Could not rank team activity for **${title}** from synced Notion metadata. Try **Sync changes**, or ask with a person name from the project roster.`
        : "No project or team name found for activity lookup.";
    case "team_roster":
      return title
        ? `No team members found for **${title}** in synced Notion (owner, assignee, captain, or team roster lines). Try **Sync changes** or check spelling (e.g. datapivots vs datapivot).`
        : "No project name found — e.g. **Who all are working on datapivots ai?**";
    case "project_member_breakdown":
      return `No project data found to generate a member breakdown. Try **Sync changes** or ask about a specific project with **"who is working on [project]?"**`;
    case "person_project_membership":
      return person && title
        ? `No. I couldn't find **${person}** associated with the **${title}** project in synced Notion data.`
        : "I couldn't find a person name or project title in the question to check membership.";
    case "assignee_project_check":
      return person && title
        ? `No. ${person} doesn't appear to work on ${title}.`
        : "No. they don't appear to work on that project.";
    default:
      return title || person
        ? `No matching result for this question in synced Notion data (${[title, person].filter(Boolean).join(" · ")}). Try **Sync changes** or rephrase with an exact page/person name.`
        : "No matching result for this question in synced Notion data. Try **Sync changes** or rephrase with an exact page/person name from Notion.";
  }
}

// ---------------------------------------------------------------------------
// Answer quality / RAG fallback checks (formerly answer-quality.ts)
// ---------------------------------------------------------------------------

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