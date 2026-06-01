import type { ParsedQuery, QueryKind } from "@/lib/query/types";

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
        : "No page title found for owner lookup.";
    case "assigned_list":
      return person
        ? `No tasks or pages found assigned to **${person}** in synced Notion data. Try **Sync changes** or rephrase with a year, e.g. tasks assigned to Tamanna in 2025.`
        : "No assignee name found in the question.";
    case "assigned_to_of":
      return title
        ? `No assignee found for **${title}** in synced Notion data. Use **Sync changes** if assignments changed recently.`
        : "No page title found for assignee lookup.";
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
    default:
      return title || person
        ? `No matching result for this question in synced Notion data (${[title, person].filter(Boolean).join(" · ")}). Try **Sync changes** or rephrase with an exact page/person name.`
        : "No matching result for this question in synced Notion data. Try **Sync changes** or rephrase with an exact page/person name from Notion.";
  }
}
