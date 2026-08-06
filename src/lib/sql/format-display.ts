/**
 * Consistent, readable markdown for SQL-backed chat answers.
 */
import type { NotionPageRow } from "@/lib/shared/notion-types";

export const DISPLAY_SNIPPET_MAX = 200;
export const DISPLAY_TASK_MAX = 12;
export const DISPLAY_SCOPE_BULLETS = 4;

const PROPERTIES_MARKER = "=== PROPERTIES ===";
const CONTENT_MARKER = "=== CONTENT ===";

export function formatDisplayLink(title: string, url: string | null | undefined) {
  return url ? `[${title}](${url})` : title;
}

export function stripNotionBodyRaw(content?: string | null, maxLength?: number) {
  const raw = (content || "").trim();
  if (!raw) return "";

  const start = raw.indexOf(CONTENT_MARKER);
  const body = (start >= 0 ? raw.slice(start + CONTENT_MARKER.length) : raw)
    .replace(/^Title:.*$/m, "")
    .replace(/^URL:.*$/m, "")
    .trim();

  if (maxLength && body.length > maxLength) {
    return body.slice(0, maxLength);
  }

  return body;
}

export function formatPageMeta(
  row: Pick<NotionPageRow, "status" | "owner" | "doc_type" | "created_by">,
) {
  const parts: string[] = [];
  if (row.status?.trim()) parts.push(`**Status:** ${row.status.trim()}`);
  if (row.owner?.trim()) parts.push(`**Owner:** ${row.owner.trim()}`);
  else if (row.created_by?.trim()) parts.push(`**Created by:** ${row.created_by.trim()}`);
  if (row.doc_type?.trim()) parts.push(`**Type:** ${row.doc_type.trim()}`);
  return parts.join(" · ");
}

/** Checkbox and plain bullets from Notion project pages. */
export function extractNotionTaskItems(content?: string | null, max = DISPLAY_TASK_MAX) {
  const body = stripNotionBodyRaw(content);
  const items: string[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    const checkbox = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      const done = checkbox[1].toLowerCase() === "x";
      items.push(`${done ? "✅" : "⬜"} ${checkbox[2].trim()}`);
      continue;
    }
    if (/^##\s+project tasks/i.test(trimmed)) continue;
    const plain = trimmed.match(/^[-*]\s+(.+)$/);
    if (
      plain &&
      plain[1].length >= 3 &&
      plain[1].length < 72 &&
      !plain[1].startsWith("[") &&
      !/^#/.test(plain[1])
    ) {
      items.push(`• ${plain[1].trim()}`);
    }
    if (items.length >= max) break;
  }

  return items.slice(0, max);
}

/** Short scope bullets from About / first bullets / first paragraph. */
export function extractScopeSummary(content?: string | null, maxBullets = DISPLAY_SCOPE_BULLETS) {
  const body = stripNotionBodyRaw(content);
  const bullets: string[] = [];
  let section: "about" | "other" = "other";

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (/^##\s+about/i.test(trimmed)) {
      section = "about";
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      if (section === "about" && bullets.length) break;
      section = "other";
      continue;
    }
    if (/^[-*]\s+\[[ xX]\]/i.test(trimmed)) continue;
    if (/^[-*•]\s+/.test(trimmed) && trimmed.length > 8) {
      const text = trimmed.replace(/^[-*•]\s+/, "").replace(/^\[[ xX]\]\s*/, "");
      if (text.length > 8 && !/^\[[ xX]\]/.test(text)) {
        bullets.push(text);
        if (bullets.length >= maxBullets) return bullets;
      }
    }
  }

  if (!bullets.length) {
    const paragraph = body
      .split(/\n\n+/)
      .map((p) => p.replace(/^#+\s+/gm, "").replace(/\n/g, " ").trim())
      .find((p) => p.length > 24 && !p.startsWith("==="));
    if (paragraph) {
      const short = paragraph.length > 280 ? `${paragraph.slice(0, 280)}…` : paragraph;
      bullets.push(short);
    }
  }

  return bullets.filter((b) => !/\[[ xX]\]/.test(b) && b.length > 12);
}

/** Cost / budget lines (₹ amounts, subtotals) from a Notion page. */
export function extractCostEstimationLines(content?: string | null, max = 20) {
  const body = stripNotionBodyRaw(content);
  const lines: string[] = [];
  let inCost = false;

  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^#+\s*.*cost estimation/i.test(trimmed) || /^1\.\s*cost estimation/i.test(trimmed)) {
      inCost = true;
      continue;
    }
    if (inCost && /^2\.\s*timeline/i.test(trimmed)) break;
    if (!inCost && !/cost estimation|budget for/i.test(trimmed)) continue;

    if (/^#+\s/.test(trimmed)) {
      const heading = trimmed.replace(/^#+\s+/, "");
      if (/budget|development|infrastructure|summary|total/i.test(heading)) {
        lines.push(`**${heading}**`);
      }
      continue;
    }

    if (/₹|subtotal|total budget|total project/i.test(trimmed)) {
      lines.push(trimmed.startsWith("-") ? trimmed.replace(/^-\s+/, "") : trimmed);
    }

    if (lines.length >= max) break;
  }

  return lines;
}

export function formatCostEstimationPage(row: NotionPageRow & { content?: string | null }) {
  const costLines = extractCostEstimationLines(row.content);
  const lines: string[] = [
    `## Cost estimation — **${row.title || "Untitled"}**`,
    "",
  ];

  const meta = formatPageMeta(row);
  if (meta) lines.push(meta, "");

  const scope = extractScopeSummary(row.content, 2);
  if (scope.length) {
    lines.push("**Project**", ...scope.map((s) => `- ${s}`), "");
  }

  if (costLines.length) {
    lines.push("**Cost breakdown (from synced Notion)**", "", ...costLines.map((l) => `- ${l}`));
  } else {
    const snippet = compactSnippet(row.content, 600);
    if (snippet) lines.push(snippet);
    else lines.push("_No cost figures found in synced content._");
  }

  const timeline = stripNotionBodyRaw(row.content).match(
    /total project duration[^|]*\|?\s*([^|\n]+)/i,
  );
  if (timeline?.[1]?.trim()) {
    lines.push("", `**Timeline:** ${timeline[1].trim()}`);
  }

  if (row.url) lines.push("", formatDisplayLink("Open full report in Notion →", row.url));
  return lines.join("\n");
}

export function compactSnippet(content?: string | null, maxLength = DISPLAY_SNIPPET_MAX) {
  const cleaned = stripNotionBodyRaw(content)
    .replace(/^#+\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** One Notion page — title, meta, scope, optional tasks, link. */
export function formatPageCard(
  row: NotionPageRow & { content?: string | null },
  options?: { showTasks?: boolean },
) {
  const lines: string[] = [`#### ${row.title || "Untitled"}`];
  const meta = formatPageMeta(row);
  if (meta) lines.push(meta);

  const tasks =
    options?.showTasks !== false ? extractNotionTaskItems(row.content) : [];
  const scope = extractScopeSummary(row.content).filter(
    (b) => !/^\[[ xX]\]/i.test(b.trim()),
  );
  if (scope.length) {
    lines.push("", "**Scope**");
    for (const bullet of scope) lines.push(`- ${bullet}`);
  }

  if (tasks.length) {
    lines.push("", "**Tasks**");
    for (const task of tasks) lines.push(`- ${task}`);
  }

  if (row.url) lines.push("", formatDisplayLink("Open in Notion →", row.url));
  return lines.join("\n");
}

export function formatCompareAnswer(
  titleA: string,
  titleB: string,
  rowA: (NotionPageRow & { content?: string | null }) | null,
  rowB: (NotionPageRow & { content?: string | null }) | null,
) {
  const lines: string[] = [
    `## ${titleA} vs ${titleB}`,
    "",
    "_Synced from Notion — status, scope, and tasks below._",
    "",
  ];

  if (rowA && rowB) {
    const statusA = rowA.status?.trim() || "—";
    const statusB = rowB.status?.trim() || "—";
    const ownerA = rowA.owner?.trim() || "—";
    const ownerB = rowB.owner?.trim() || "—";
    lines.push(
      "| | **" + titleA + "** | **" + titleB + "** |",
      "| --- | --- | --- |",
      `| **Status** | ${statusA} | ${statusB} |`,
      `| **Owner** | ${ownerA} | ${ownerB} |`,
      "",
    );
  }

  if (rowA) {
    lines.push(formatPageCard(rowA));
  } else {
    lines.push(`#### ${titleA}`, "", "_Not found in synced Notion — try **Sync changes**._");
  }

  lines.push("", "---", "");

  if (rowB) {
    lines.push(formatPageCard(rowB));
  } else {
    lines.push(`#### ${titleB}`, "", "_Not found in synced Notion — try **Sync changes**._");
  }

  if (rowA && rowB) {
    lines.push("", "---", "", "_Ask about one page by full title for more detail._");
  }

  return lines.join("\n");
}

export function formatAnswerSection(title: string, bodyLines: string[]) {
  return [`### ${title}`, "", ...bodyLines].join("\n");
}

export function formatCompactListItem(
  row: NotionPageRow & { content?: string | null },
  extras?: string[],
) {
  const meta = [
    row.status ? `**${row.status}**` : "",
    row.owner ? row.owner : "",
    ...(extras ?? []),
  ]
    .filter(Boolean)
    .join(" · ");
  const title = formatDisplayLink(row.title || "Untitled", row.url);
  const snippet = compactSnippet(row.content);
  const line = meta ? `${title} — ${meta}` : title;
  return snippet ? `${line}\n  _${snippet}_` : line;
}

export function formatDetailedListItem(
  row: NotionPageRow & { content?: string | null },
  extras?: string[],
) {
  const metaParts: string[] = [];

  // 1. Status
  if (row.status?.trim()) {
    metaParts.push(`**${row.status.trim()}**`);
  }

  // 2. Owner/Assignee (avoiding duplicates if caller passes it in extras)
  const ownerVal = row.owner?.trim();
  const hasOwnerInExtras = extras?.some((e) => {
    const lower = e.toLowerCase();
    return (
      (lower.startsWith("assignee:") || lower.startsWith("owner:")) &&
      ownerVal &&
      lower.includes(ownerVal.toLowerCase())
    );
  });

  if (ownerVal && !hasOwnerInExtras) {
    metaParts.push(`owner: ${ownerVal}`);
  }

  // 3. Extras
  if (extras) {
    for (const ext of extras) {
      const trimmed = ext.trim();
      if (!trimmed) continue;

      const lowerExt = trimmed.toLowerCase();
      if (
        row.status &&
        (lowerExt === row.status.toLowerCase() ||
          lowerExt === `status: ${row.status.toLowerCase()}`)
      ) {
        continue;
      }

      metaParts.push(trimmed);
    }
  }

  const metaStr = metaParts.join(" · ");
  const title = formatDisplayLink(row.title || "Untitled", row.url);
  const mainLine = metaStr ? `${title} — ${metaStr}` : title;

  const lines = [mainLine];

  // Extract Scope/Overview
  const scope = extractScopeSummary(row.content, 4);
  if (scope.length) {
    lines.push("  - **What's Inside / Scope**:");
    for (const s of scope) {
      lines.push(`    - ${s}`);
    }
  }

  // Extract Tasks/Checklist
  const tasks = extractNotionTaskItems(row.content, 5);
  if (tasks.length) {
    lines.push("  - **Tasks**:");
    for (const t of tasks) {
      const cleanTask = t.startsWith("• ") ? t.slice(2) : t;
      lines.push(`    - ${cleanTask}`);
    }
  }

  // Fallback snippet if both are empty
  if (!scope.length && !tasks.length) {
    const snippet = compactSnippet(row.content, 250);
    if (snippet) {
      lines.push(`  - **Summary**: ${snippet}`);
    } else {
      lines.push(`  - _No additional content found in the synced page._`);
    }
  }

  return lines.join("\n");
}

