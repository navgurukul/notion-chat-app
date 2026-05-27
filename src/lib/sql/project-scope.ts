import type { NotionPageRow } from "@/lib/shared/notion-types";
import { scoreTitleForTopic, titlesReferToSameTopic } from "@/lib/query/topic-resolution";

/** Bug/incident tickets that mention a project name but are not project status rows. */
export function isBugOrIncidentTitle(title: string | null | undefined) {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (/^(tc-\d+|bug\b)/i.test(t)) return true;
  if (/^"/.test(t) || /\[[^\]]+\]/.test(t)) return true;
  return /\b(figma|mismatch|incorrect|capitalization|permission|privacy policy|terms of use|overlap|dnd|transcription|keyboard|logo text|header section|flutter app)\b/i.test(
    t,
  );
}

/**
 * Keep pages that belong to a project topic (hub, MVP, PRD, scoped tasks) — drop noise tickets.
 */
export function filterPagesForProjectTopic(
  topic: string,
  pages: Array<NotionPageRow & { content?: string | null }>,
  options?: { minTitleScore?: number },
) {
  const minScore = options?.minTitleScore ?? 350;
  const tokens = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["project", "the", "app", "ai"].includes(t));
  const primary = tokens[0] ?? topic.toLowerCase().trim();

  return pages.filter((row) => {
    const title = row.title ?? "";
    if (isBugOrIncidentTitle(title)) return false;

    const titleScore = scoreTitleForTopic(topic, title);
    if (titleScore >= minScore) return true;

    if (titlesReferToSameTopic(topic, title)) {
      if (isBugOrIncidentTitle(title)) return false;
      return true;
    }

    if (primary && new RegExp(`\\b${primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title)) {
      if (/^(oscar|stub|zuvy|meraki|journaling|datapivot|nagaada)\b/i.test(title)) return true;
      if (new RegExp(`^${primary}\\s+(app|mvp|prd|modes|platform|project|hub|\\+\\+)`, "i").test(title)) {
        return true;
      }
    }

    return false;
  });
}

export function primaryTopicToken(topic: string) {
  const tokens = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !["project", "the", "completion", "workspace"].includes(t));
  return tokens[0] ?? topic.trim().toLowerCase();
}
