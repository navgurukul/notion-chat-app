/**
 * SQL answers — lookup owners, status, assignments, summaries from `notion_pages`.
 *
 * No Gemini here. If this returns null, the chat pipeline falls back to RAG.
 */
import { escapeLike, query } from "@/lib/db";
import type { ActivityRow, NotionPageRow, WorkedOnRow } from "@/lib/shared/notion-types";
import { normalizePersonNameForMatch } from "@/lib/query/normalize";
import { isNoiseTopic } from "@/lib/query/rules";
import type { ParsedQuery } from "@/lib/query/types";
import {
  compactSnippet,
  formatCompareAnswer,
  formatCompactListItem,
  formatCostEstimationPage,
  formatPageCard,
} from "@/lib/sql/format-display";
import { filterPagesForProjectTopic, primaryTopicToken } from "@/lib/sql/project-scope";
import {
  aggregatePeopleOnProject,
  extractProjectScopeTopic,
  fetchProjectPages,
} from "@/lib/sql/team-roster";

const SQL_RESULT_LIMIT = 20;
const HISTORICAL_PROJECT_LIMIT = 50;

const ACTIVE_STATUSES = new Set([
  "in progress",
  "testing",
  "scoping",
  "not started",
  "blocked",
  "on hold",
]);

function isActiveStatus(status: string | null | undefined) {
  if (!status?.trim()) return false;
  return ACTIVE_STATUSES.has(status.trim().toLowerCase());
}

function stripVowels(value: string) {
  return value.toLowerCase().replace(/[aeiou]/g, "");
}

function normalizeTopic(value: string) {
  return value
    .replace(/\b(projects?|tasks?|work|worked|data|docs?|documents?|pages?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatLink(title: string, url: string | null) {
  return url ? `[${title}](${url})` : title;
}

/** Notion pages often lack an Owner property; fall back to creator / editor. */
function resolvePageOwner(row: NotionPageRow): { name: string | null; label: string } {
  if (row.owner?.trim()) {
    return { name: row.owner.trim(), label: "Owner" };
  }
  if (row.created_by?.trim()) {
    return { name: row.created_by.trim(), label: "Created by" };
  }
  if (row.last_edited_by?.trim()) {
    return { name: row.last_edited_by.trim(), label: "Last edited by" };
  }
  const fromContent = (row.content || "").match(/^Created by:\s*(.+)$/m);
  if (fromContent?.[1]?.trim()) {
    return { name: fromContent[1].trim(), label: "Created by" };
  }
  return { name: null, label: "Owner" };
}

/** Direct Notion URL lookup by page title (exact, then ranked partial). */
export async function lookupPageLinkByTitle(docTitle: string): Promise<string | null> {
  const trimmed = docTitle.trim();
  if (trimmed.length < 2) return null;

  const ranked = await lookupByTitle(trimmed, false);
  const row = ranked[0];
  if (!row) return null;
  if (!row.url) {
    return `Found **${row.title || "Untitled"}**, but no Notion URL is stored for it.`;
  }
  return `**${row.title || "Untitled"}**\n\n[Open in Notion](${row.url})`;
}

function formatListHeader(count: number, label: string) {
  return `## ${count} result(s) — ${label}`;
}

function formatRows(rows: NotionPageRow[], formatter: (row: NotionPageRow) => string) {
  const visibleRows = rows.slice(0, SQL_RESULT_LIMIT);
  const renderedRows = visibleRows.map((row) => `- ${formatter(row)}`).join("\n");
  if (rows.length <= SQL_RESULT_LIMIT) return renderedRows;
  return `${renderedRows}\n\n_Showing top ${SQL_RESULT_LIMIT}. Please narrow the question for more specific results._`;
}

function extractPageBody(content?: string | null, maxLength = 2400) {
  const raw = (content || "").trim();
  if (!raw) return "";

  const marker = "=== CONTENT ===";
  const start = raw.indexOf(marker);
  const body = (start >= 0 ? raw.slice(start + marker.length) : raw)
    .replace(/^Title:.*$/m, "")
    .replace(/^URL:.*$/m, "")
    .trim();

  if (!body) return "";
  return body.length > maxLength ? `${body.slice(0, maxLength)}...` : body;
}

function contentSnippet(content?: string | null, maxLength = 200) {
  return compactSnippet(content, maxLength);
}

const PROJECT_THEMES = [
  {
    name: "Reports and Dashboards",
    hubTitleLike: "%reports and dashboard%",
    signals: [/report/i, /dashboard/i, /pdf/i, /executive/i, /pagination/i, /widget/i, /key-insight/i],
  },
  {
    name: "Role-based access & platform",
    hubTitleLike: "%role based access%",
    signals: [/role/i, /\bapi\b/i, /socket/i, /routing/i, /login/i],
  },
  {
    name: "Reflection Platform",
    hubTitleLike: "%reflection%",
    signals: [/reflection/i, /facilitator/i, /student view/i, /competency/i, /skill analysis/i],
  },
  {
    name: "Meraki",
    hubTitleLike: "%meraki%",
    signals: [/meraki/i, /merakilearn/i],
  },
  {
    name: "Oscar",
    hubTitleLike: "%oscar%",
    signals: [/oscar/i],
  },
  {
    name: "DataPivots AI",
    hubTitleLike: "%datapivot%",
    signals: [/datapivot/i, /data pivot/i, /nagaada/i, /pivotsai/i],
  },
] as const;

function projectSearchTokens(topic: string) {
  const stop = new Set(["project", "the", "ai", "app", "platform"]);
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t));
}

function rankProjectHubRow(
  row: NotionPageRow & { content?: string | null },
  tokens: string[],
) {
  const title = (row.title || "").toLowerCase();
  const content = (row.content || "").toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (title.includes(token)) score += 10;
    else if (content.includes(token)) score += 2;
  }

  if (row.owner?.trim()) score += 5;
  if (/in development|in progress|testing|scoping/i.test(row.status || "")) score += 4;
  if (/crisis|high/i.test(content)) score += 1;

  const contentLen = (row.content || "").length;
  if (contentLen > 1000) score += 5;
  else if (contentLen > 400) score += 2;
  else if (contentLen < 150) score -= 4;

  if (/proposal|sow|release|platform|nagaada|roadmap/i.test(title)) score += 4;
  if (/^click on|icon$|sign in screen$/i.test(title)) score -= 12;
  if (/^data insights with/i.test(title) && contentLen < 300) score -= 8;

  return score;
}

async function searchProjectPages(topic: string) {
  const tokens = projectSearchTokens(topic);
  if (!tokens.length) return [];

  const primary = `%${escapeLike(tokens[0])}%`;
  const rows = await query<NotionPageRow & { content: string | null }>(
    `
    SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      ${tokens.length > 1 ? `OR lower(coalesce(title, '')) LIKE lower($2) ESCAPE '\\'` : ""}
    LIMIT 40
    `,
    tokens.length > 1
      ? [primary, `%${escapeLike(tokens[1])}%`]
      : [primary],
  );

  return rows
    .map((row) => ({ row, score: rankProjectHubRow(row, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.row);
}

async function buildProjectSummary(topic: string) {
  const pages = await searchProjectPages(topic);
  if (!pages.length) return null;

  const hub = pages[0];
  const hubBody = extractPageBody(hub.content, 1200);
  const related = pages.slice(1, 12);

  const statusCounts = new Map<string, number>();
  for (const row of pages) {
    const status = row.status?.trim() || "not set";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  const activeStatuses = [...statusCounts.entries()]
    .filter(([s]) => /in development|in progress|testing|scoping/i.test(s))
    .map(([s, n]) => `${s} (${n})`);

  const lines: string[] = [
    `## ${hub.title || topic}`,
    [
      hub.status ? `**Status:** ${hub.status}` : "",
      hub.owner ? `**Owner:** ${hub.owner}` : "",
      hub.created_by ? `**Created by:** ${hub.created_by}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    "",
    hubBody
      ? hubBody
      : "_Main project page has limited body text in sync — see related pages below._",
    hub.url ? `\n${formatLink("Open main page in Notion", hub.url)}` : "",
    "",
    `**Scope (${pages.length} related pages in Notion):**`,
    activeStatuses.length
      ? `Active work: ${activeStatuses.join(", ")}`
      : `_Statuses: ${[...statusCounts.entries()].slice(0, 6).map(([s, n]) => `${s} (${n})`).join(", ")}_`,
    "",
    "**Key related pages:**",
  ];

  for (const row of related) {
    const meta = [row.status ? `status: ${row.status}` : "", row.owner ? `owner: ${row.owner}` : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- **${formatLink(row.title || "Untitled", row.url)}**${meta ? ` — ${meta}` : ""}`);
  }

  if (pages.length > 13) {
    lines.push("", `_+${pages.length - 13} more related pages in Notion._`);
  }

  return lines.filter((line) => line !== "").join("\n");
}

function wantsProjectNameAnswer(raw: string) {
  return /\b(?:which|what|all)\b[\s\S]*\bprojects?\b/i.test(raw);
}

function asksForProjectsOnly(raw: string) {
  return /\bprojects?\b/i.test(raw) && !/\btasks?\b/i.test(raw);
}

function asksForTasksOnly(raw: string) {
  return /\btasks?\b/i.test(raw);
}

/** Person named on a project team roster or billing line in page body (not only Owner field). */
function personOnProjectTeam(content: string | null | undefined, person: string) {
  if (!content?.trim()) return false;
  const norm = person.toLowerCase().trim();
  const fuzzy = stripVowels(norm);
  const text = content.toLowerCase();
  if (!text.includes(norm) && !text.replace(/[aeiou]/g, "").includes(fuzzy)) return false;

  const firstName = norm.split(/\s+/)[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? norm;
  if (!firstName) return false;

  if (new RegExp(`\\bdevs?\\b[\\s\\S]{0,500}${firstName}`, "i").test(content)) return true;
  if (new RegExp(`\\bteam\\b[\\s\\S]{0,400}${firstName}`, "i").test(content)) return true;
  if (new RegExp(`${firstName}[\\s\\S]{0,60}(?:per month|billable|rs\\s|\\d+,?\\d{3})`, "i").test(content))
    return true;
  if (new RegExp(`\\bassignee:\\s*[^\\n]*${firstName}`, "i").test(content)) return true;
  if (new RegExp(`\\bcaptain:\\s*[^\\n]*${firstName}`, "i").test(content)) return true;
  return false;
}

function inferProjectThemeForPage(row: { title?: string | null; content?: string | null }) {
  const title = (row.title ?? "").toLowerCase();
  const contentHead = (row.content ?? "").slice(0, 1200).toLowerCase();

  if (/datapivot|nagaada|data pivot|pivotsai/.test(title)) return "DataPivots AI";
  if (/product roadmap|roadmap.*execution/.test(title) && /datapivot|nagaada/.test(contentHead)) {
    return "DataPivots AI";
  }
  if (/reports and dashboard|release 2\.1/.test(title)) return "Reports and Dashboards";
  if (/meraki/.test(title)) return "Meraki";
  if (/oscar/.test(title)) return "Oscar";
  if (/reflection platform|^reflection$/i.test(title)) return "Reflection Platform";

  return inferProjectTheme([row]);
}

function ownedProjectHubForTheme(theme: string, rows: NotionPageRow[]) {
  const norm = theme.toLowerCase();
  const exact = rows.find((row) => (row.title ?? "").trim().toLowerCase() === norm);
  if (exact) return { title: exact.title, url: exact.url ?? null };
  const partial = rows.find(
    (row) =>
      (row.title ?? "").toLowerCase().includes(norm) &&
      !(row.title ?? "").toLowerCase().includes("induction"),
  );
  return partial ? { title: partial.title, url: partial.url ?? null } : null;
}

function attachOrphanTasksToOwnedProject(
  byTheme: Map<string, { tasks: NotionPageRow[]; rosterHub?: { title: string | null; url: string | null } }>,
  rows: NotionPageRow[],
) {
  const primary = [...byTheme.entries()].find(([theme]) => ownedProjectHubForTheme(theme, rows));
  if (!primary) return;
  const [, entry] = primary;
  const seen = new Set(entry.tasks.map((r) => r.id));
  for (const row of rows) {
    if (inferProjectThemeForPage(row) || seen.has(row.id)) continue;
    entry.tasks.push(row);
    seen.add(row.id);
  }
}

async function findProjectRosterThemes(person: string) {
  const personTerm = `%${escapeLike(person)}%`;
  const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
  const rows = await query<{ title: string | null; url: string | null; content: string | null }>(
    `
    SELECT title, url, content
    FROM notion_pages
    WHERE
      (
        lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(content, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
      )
      AND (
        lower(coalesce(title, '')) LIKE '%datapivot%'
        OR lower(coalesce(title, '')) LIKE '%nagaada%'
        OR lower(coalesce(title, '')) LIKE '%roadmap%'
        OR lower(coalesce(title, '')) LIKE '%release%'
        OR lower(coalesce(title, '')) LIKE '%meraki%'
        OR lower(coalesce(title, '')) LIKE '%oscar%'
        OR lower(coalesce(title, '')) LIKE '%reflection%'
        OR lower(coalesce(title, '')) LIKE '%reports and dashboard%'
        OR lower(coalesce(title, '')) LIKE '%sow%'
      )
    LIMIT 30
    `,
    [personTerm, fuzzyPersonTerm],
  );

  const seen = new Set<string>();
  const out: Array<{ theme: string; hubTitle: string; hubUrl: string | null }> = [];
  for (const row of rows) {
    if (!personOnProjectTeam(row.content, person)) continue;
    const theme = inferProjectThemeForPage(row);
    if (!theme || seen.has(theme)) continue;
    seen.add(theme);
    out.push({
      theme,
      hubTitle: row.title || theme,
      hubUrl: row.url,
    });
  }
  return out;
}

async function formatAssignedProjectsAnswer(
  person: string,
  rows: NotionPageRow[],
  yearNote: string,
) {
  type ThemeEntry = {
    tasks: NotionPageRow[];
    rosterHub?: { title: string | null; url: string | null };
  };
  const byTheme = new Map<string, ThemeEntry>();

  for (const row of rows) {
    const theme = inferProjectThemeForPage(row);
    if (!theme) continue;
    const entry = byTheme.get(theme) ?? { tasks: [] };
    entry.tasks.push(row);
    byTheme.set(theme, entry);
  }

  for (const roster of await findProjectRosterThemes(person)) {
    const entry = byTheme.get(roster.theme) ?? { tasks: [] };
    if (!entry.rosterHub) {
      entry.rosterHub = { title: roster.hubTitle, url: roster.hubUrl };
    }
    byTheme.set(roster.theme, entry);
  }

  attachOrphanTasksToOwnedProject(byTheme, rows);

  const themes = [...byTheme.entries()]
    .sort((a, b) => {
      const score = (e: ThemeEntry) =>
        e.tasks.length + (e.rosterHub ? 3 : 0) + e.tasks.filter((r) => isActiveStatus(r.status)).length;
      return score(b[1]) - score(a[1]);
    })
    .map(([name]) => name);

  const lines: string[] = [];
  lines.push(
    `## Projects — **${person}**${yearNote}`,
    "",
    `_${rows.length} owned/assigned pages + team rosters in synced Notion._`,
    `_Task list: ask **"What tasks is ${person} assigned to?"**_`,
    "",
  );

  if (!themes.length) {
    return (
      `No **projects** found for **${person}**${yearNote} in synced Notion (no owner/assignee tasks and no team roster match).\n\n` +
      `_Try **Sync changes** if assignments were updated recently._`
    );
  }

  for (const theme of themes.slice(0, 10)) {
    const entry = byTheme.get(theme)!;
    const hub =
      ownedProjectHubForTheme(theme, rows) ??
      (await lookupProjectHubPage(theme)) ??
      entry.rosterHub;
    const activeCount = entry.tasks.filter((row) => isActiveStatus(row.status)).length;
    const hubLink = hub?.url
      ? formatLink(hub.title || theme, hub.url)
      : `**${theme}**`;

    const parts: string[] = [];
    if (entry.rosterHub && entry.tasks.length === 0) {
      parts.push("on **project team** (from roster)");
    } else if (entry.rosterHub) {
      parts.push("on project team + **owner/assignee** on tasks");
    } else {
      parts.push(`**${entry.tasks.length}** owned/assigned task(s)`);
    }
    if (activeCount) parts.push(`**${activeCount}** active task(s)`);

    const sampleTasks = entry.tasks
      .filter((row) => isActiveStatus(row.status))
      .slice(0, 2)
      .map((row) => row.title || "Untitled");

    let line = `- **${theme}** — ${hubLink} — ${parts.join(", ")}`;
    if (sampleTasks.length) line += ` (e.g. ${sampleTasks.join(", ")})`;
    lines.push(line);
  }

  if (themes.length > 10) {
    lines.push("", `_+${themes.length - 10} more project areas._`);
  }

  return lines.join("\n");
}

function wantsAllProjectsList(raw: string) {
  return /\ball\s+(?:the\s+)?projects?\b/i.test(raw);
}

function isHistoricalWorkQuery(raw: string) {
  return (
    /\b(?:worked|has worked|have worked)\b/i.test(raw) &&
    !/\b(?:is\s+)?working\s+on\b/i.test(raw)
  );
}

/** "Navgurukul workspace" means whole synced DB — not a page title filter. */
function isWorkspaceScope(scope?: string) {
  if (!scope?.trim()) return true;
  const t = scope.toLowerCase();
  if (/\b(workspace|navgurukul|ng)\b/.test(t) && t.length < 40) return true;
  return isNoiseTopic(scope);
}

function isBlockerStatus(status: string | null | undefined) {
  const s = (status ?? "").trim().toLowerCase();
  if (!s || s === "not set") return false;
  return /block/.test(s) || ["on hold", "waiting", "stuck"].includes(s);
}

function formatBlockerListAnswer(
  rows: NotionPageRow[],
  scopeLabel?: string,
) {
  const blocked = rows.filter((row) => /block/i.test(row.status ?? ""));
  const onHold = rows.filter(
    (row) =>
      isBlockerStatus(row.status) &&
      !/block/i.test(row.status ?? "") &&
      /hold|waiting|stuck/i.test(row.status ?? ""),
  );

  const scopeNote = scopeLabel
    ? isWorkspaceScope(scopeLabel)
      ? "_Across all synced Navgurukul Notion pages (workspace-wide)._"
      : `_Filtered by **${scopeLabel}** in title or content._`
    : "_Across all synced Notion pages._";

  const lines: string[] = [
    `## Blockers — ${rows.length} item(s)${scopeLabel && !isWorkspaceScope(scopeLabel) ? ` (${scopeLabel})` : ""}`,
    "",
    scopeNote,
    "",
  ];

  const renderSection = (label: string, sectionRows: NotionPageRow[]) => {
    if (!sectionRows.length) return;
    lines.push(`**${label} (${sectionRows.length})**`, "");
    for (const row of sectionRows) {
      const theme = inferProjectThemeForPage(row);
      lines.push(
        `- ${formatCompactListItem(row, theme ? [theme] : undefined)}`,
      );
    }
    lines.push("");
  };

  renderSection("Blocked", blocked);
  renderSection("On hold / waiting", onHold);

  const other = rows.filter((row) => !blocked.includes(row) && !onHold.includes(row));
  if (other.length) {
    renderSection("Other flagged items", other);
  }

  lines.push(
    `_Only pages with **Blocked** / **On Hold** status in Notion are listed (not checklist text that mentions “blocker”)._`,
  );

  return lines.join("\n");
}

function inferProjectTheme(rows: Array<{ title?: string | null; content?: string | null }>) {
  const titleText = rows.map((row) => row.title ?? "").join(" ").toLowerCase();
  const combined = rows
    .map((row) => `${row.title ?? ""} ${(row.content ?? "").slice(0, 400)}`)
    .join(" ")
    .toLowerCase();

  let best: { name: string; score: number } | null = null;
  for (const theme of PROJECT_THEMES) {
    let score = theme.signals.reduce((n, pattern) => n + (pattern.test(combined) ? 1 : 0), 0);
    const titleHits = theme.signals.reduce((n, pattern) => n + (pattern.test(titleText) ? 1 : 0), 0);
    if (titleHits) score += titleHits;
    const minScore = theme.name === "DataPivots AI" && /datapivot|nagaada|data pivot|pivotsai/.test(titleText)
      ? 1
      : 2;
    if (score >= minScore && (!best || score > best.score)) best = { name: theme.name, score };
  }
  return best?.name ?? null;
}

async function buildComparePages(titleA: string, titleB: string) {
  const rowsA = await lookupByTitle(titleA, true);
  const rowsB = await lookupByTitle(titleB, true);

  if (!rowsA.length && !rowsB.length) {
    return pageNotSyncedMessage(`${titleA} / ${titleB}`);
  }

  return formatCompareAnswer(titleA, titleB, rowsA[0] ?? null, rowsB[0] ?? null);
}

async function buildRisksAnswer(topic: string) {
  const tokens = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !["mobile", "app", "main", "the"].includes(t));
  const primary = tokens[0] || topic;
  const term = `%${escapeLike(primary)}%`;

  const rows = await query<NotionPageRow & { content: string | null }>(
    `
    SELECT id, title, url, owner, status, content
    FROM notion_pages
    WHERE
      (
        lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      )
      AND (
        lower(coalesce(content, '')) ~ '(risk|risks|concern|challenge|limitation|mitigation|blocker|dependency)'
        OR lower(coalesce(title, '')) ~ '(risk|risks|concern|challenge)'
      )
    ORDER BY
      CASE WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 0 ELSE 1 END,
      length(coalesce(content, '')) DESC
    LIMIT ${SQL_RESULT_LIMIT}
    `,
    [term],
  );

  if (!rows.length) {
    const fallback = await lookupByTitle(topic, true);
    if (fallback.length) {
      const hub = fallback[0];
      const body = extractPageBody(hub.content, 1500);
      const riskLines = (body || "")
        .split(/\n/)
        .filter((line) => /risk|concern|challenge|limitation|mitigation|blocker/i.test(line))
        .slice(0, 12);
      if (riskLines.length) {
        return [
          `## Risks / concerns — **${hub.title || topic}**`,
          "",
          riskLines.map((l) => `- ${l.trim()}`).join("\n"),
          hub.url ? `\n${formatLink("Open in Notion", hub.url)}` : "",
        ].join("\n");
      }
    }
    return null;
  }

  const lines: string[] = [
    `## Risks / concerns mentioned for **${topic}**`,
    "",
    `_${rows.length} synced page(s) mention risks or concerns._`,
    "",
  ];

  for (const row of rows.slice(0, 8)) {
    const snippet = contentSnippet(row.content, 500);
    const riskSnippet = snippet
      .split(/(?<=[.!?])\s+/)
      .filter((s) => /risk|concern|challenge|limitation|mitigation|blocker/i.test(s))
      .slice(0, 2)
      .join(" ");
    lines.push(
      `- **${formatLink(row.title || "Untitled", row.url)}**${row.status ? ` — ${row.status}` : ""}${riskSnippet ? `\n  ${riskSnippet}` : snippet ? `\n  ${snippet}` : ""}`,
    );
  }

  return lines.join("\n");
}

async function buildOnboardingTasksAnswer() {
  const rows = await query<NotionPageRow & { content: string | null }>(
    `
    SELECT id, title, url, owner, status, content
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE '%onboarding%task%'
      OR lower(coalesce(title, '')) = lower('employee onboarding hub')
      OR (
        lower(coalesce(title, '')) LIKE '%employee onboarding%'
        AND lower(coalesce(content, '')) LIKE '%onboarding tasks%'
      )
    ORDER BY
      CASE WHEN lower(coalesce(title, '')) LIKE '%onboarding%task%' THEN 0 ELSE 1 END,
      title ASC
    LIMIT ${SQL_RESULT_LIMIT}
    `,
  );

  const hub =
    rows.find((r) => /employee onboarding hub/i.test(r.title || "")) ??
    (await lookupByTitle("Employee Onboarding Hub", true))[0];

  const taskPages = rows.filter((r) => /onboarding task/i.test(r.title || ""));

  const checklistFromHub = hub
    ? (extractPageBody(hub.content, 2000) || "")
        .split(/\n/)
        .filter((line) => /^[-*•\d]/.test(line.trim()) || /task|training|document|intro|submit/i.test(line))
        .slice(0, 20)
    : [];

  const lines: string[] = [
    "## Onboarding tasks for new hires",
    "",
    "_From synced **Employee Onboarding Hub** and related Notion pages._",
    "",
    "**Standard flow:**",
    "1. PnC adds the new hire to the **Onboarding Tracker**",
    "2. Tasks are created from the standard checklist",
    "3. New hire completes training, document submissions, and team intros",
    "4. Progress rolls up in the Onboarding Tracker; manager is notified when complete",
    "",
  ];

  if (checklistFromHub.length) {
    lines.push("**Checklist items from hub:**");
    for (const line of checklistFromHub.slice(0, 14)) {
      lines.push(`- ${line.replace(/^[-*•\d.]+\s*/, "").trim()}`);
    }
    lines.push("");
  }

  if (taskPages.length) {
    lines.push(`**${taskPages.length} task page(s) in Notion:**`);
    for (const row of taskPages.slice(0, 12)) {
      lines.push(
        `- **${formatLink(row.title || "Untitled", row.url)}**${row.status ? ` — ${row.status}` : ""}`,
      );
    }
  } else if (hub) {
    lines.push(`**Hub:** ${formatLink(hub.title || "Employee Onboarding Hub", hub.url)}`);
    lines.push("", "_Open the hub for **Onboarding Tasks** and **Onboarding Tracker** databases._");
  } else {
    return null;
  }

  if (hub?.url) {
    lines.push("", formatLink("Open Employee Onboarding Hub in Notion", hub.url));
  }

  return lines.join("\n");
}

function collectProjectThemes(rows: Array<{ title?: string | null; content?: string | null }>) {
  const scores = new Map<string, number>();
  for (const row of rows) {
    const theme = inferProjectThemeForPage(row) ?? inferProjectTheme([row]);
    if (!theme) continue;
    scores.set(theme, (scores.get(theme) ?? 0) + 1);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

async function lookupProjectHubPage(themeName: string) {
  const theme = PROJECT_THEMES.find((t) => t.name === themeName);
  if (!theme) return null;
  const rows = await query<{ title: string | null; url: string | null }>(
    `
    SELECT title, url
    FROM notion_pages
    WHERE lower(coalesce(title, '')) LIKE $1
      AND length(coalesce(title, '')) > 10
      AND length(coalesce(title, '')) < 80
      AND lower(coalesce(title, '')) NOT LIKE '%creation%'
      AND lower(coalesce(title, '')) NOT LIKE '%widget%'
      AND lower(coalesce(title, '')) NOT LIKE '%pagination%'
      AND lower(coalesce(title, '')) NOT LIKE '%routing (fe)%'
      AND lower(coalesce(title, '')) NOT LIKE '%induction%'
      AND lower(coalesce(title, '')) NOT LIKE '%capstone%'
      AND lower(coalesce(title, '')) NOT LIKE '%metacognition%'
    ORDER BY
      CASE WHEN lower(trim(title)) = lower(trim($2)) THEN 0
           WHEN lower(title) LIKE '%nagaada%' OR lower(title) LIKE '%datapivot%' THEN 1
           WHEN lower(title) LIKE '%release%' OR lower(title) LIKE '%roadmap%' THEN 2
           WHEN lower(title) LIKE '%reports and dashboard%' THEN 2
           WHEN lower(title) LIKE '%role based access%' THEN 3
           ELSE 4 END,
      length(title) ASC
    LIMIT 1
    `,
    [theme.hubTitleLike, themeName],
  );
  return rows[0] ?? null;
}

function formatActivityRowLine(row: NotionPageRow & { notion_edited_at?: string | null; activity_role?: string | null }) {
  const meta = [
    row.activity_role ? `role: ${row.activity_role}` : "",
    row.owner ? `owner: ${row.owner}` : "",
    row.status ? `status: ${row.status}` : "",
    row.notion_edited_at
      ? `last edited: ${new Date(row.notion_edited_at).toLocaleDateString()}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `**${formatLink(row.title || "Untitled", row.url)}** — ${meta}`;
}

async function lookupProjectStatusPages(topic: string) {
  const ranked = await searchProjectPages(topic);
  const scoped = filterPagesForProjectTopic(topic, ranked);
  if (scoped.length) return scoped.slice(0, SQL_RESULT_LIMIT);

  const token = primaryTopicToken(topic);
  const term = `%${escapeLike(token)}%`;
  const fallback = await query<NotionPageRow & { content: string | null }>(
    `
    SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content
    FROM notion_pages
    WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
    ORDER BY length(coalesce(title, '')) ASC, title ASC
    LIMIT 40
    `,
    [term],
  );
  const filtered = filterPagesForProjectTopic(topic, fallback);
  return filtered.slice(0, SQL_RESULT_LIMIT);
}

const TITLE_STOP_WORDS = new Set([
  "for",
  "the",
  "and",
  "with",
  "from",
  "about",
  "page",
  "doc",
  "document",
  "proposal",
]);

function titleMatchScore(rowTitle: string, queryTitle: string) {
  const row = (rowTitle || "").toLowerCase().trim();
  const query = queryTitle.toLowerCase().trim();
  if (!row || !query) return 0;
  if (row === query) return 1000;
  if (row.includes(query)) return 800 + query.length;
  if (query.includes(row) && row.length >= 12) return 600 + row.length;

  const tokens = query
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !TITLE_STOP_WORDS.has(t));

  if (!tokens.length) return 0;

  let matched = 0;
  for (const token of tokens) {
    if (row.includes(token)) matched += 1;
  }

  const required = tokens.length <= 2 ? tokens.length : Math.max(2, Math.ceil(tokens.length * 0.5));
  if (matched < required) return matched * 10;
  return 200 + matched * 80 + Math.min(row.length, query.length);
}

function pageNotSyncedMessage(docTitle: string) {
  return (
    `I couldn't find **${docTitle}** in the synced Notion database.\n\n` +
    `Use **Sync changes** in the sidebar (or a full sync if the page is new), then ask again with the full page title.`
  );
}

function projectTopicTokens(topic: string) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !["project", "completion", "the"].includes(t));
}

function extractCharterSection(content: string, tokens: string[]) {
  if (!tokens.length) return null;
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(
    `##\\s*\\d*\\.?\\s*[^\\n]*(?:${pattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+\\d|$)`,
    "i",
  );
  return content.match(re)?.[1]?.trim() ?? null;
}

function extractTimelineBullets(text: string, max = 8) {
  const bullets: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^[-*•]\s+/.test(trimmed) && trimmed.length > 8) {
      bullets.push(trimmed.replace(/^[-*•]\s+/, ""));
    }
    if (bullets.length >= max) break;
  }
  return bullets;
}

function extractDateMentions(text: string) {
  const found = new Set<string>();
  const patterns = [
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/gi,
    /\b(?:may|june)\s+and\s+(?:may|june)\s+20\d{2}\b/gi,
    /\bby\s+(?:may|june|q[1-4]|[a-z]+)\s+(?:end|20\d{2})\b/gi,
    /\b(?:due|deadline|target|launch|release|completion|eta)\s*(?:date)?\s*[:\-]\s*[^\n]+/gi,
    /\b20\d{2}-\d{2}-\d{2}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = match[0].trim();
      if (line.length > 4 && line.length < 120) found.add(line);
    }
  }
  return [...found].slice(0, 8);
}

function partitionDateMentions(mentions: string[]) {
  const currentYear = new Date().getFullYear();
  const current: string[] = [];
  const older: string[] = [];

  for (const mention of mentions) {
    const yearMatch = mention.match(/\b(20\d{2})\b/);
    if (!yearMatch) {
      current.push(mention);
      continue;
    }
    const year = Number.parseInt(yearMatch[1], 10);
    if (year >= currentYear) current.push(mention);
    else older.push(mention);
  }

  return { current, older };
}

async function findRelatedProjectPages(topic: string) {
  const tokens = projectTopicTokens(topic);
  const primary = tokens[0] ?? topic.split(/\s+/)[0] ?? topic;
  if (primary.length < 3) return [];

  const term = `%${escapeLike(primary)}%`;
  return query<NotionPageRow & { content: string | null }>(
    `
    SELECT id, title, url, owner, doc_type, status, content
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
    ORDER BY
      CASE WHEN lower(trim(coalesce(title, ''))) = lower(trim($2)) THEN 0
           WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 1
           ELSE 2 END,
      CASE WHEN lower(coalesce(title, '')) LIKE '%charter%' THEN 0
           WHEN lower(coalesce(title, '')) LIKE '%roadmap%' THEN 1
           WHEN lower(coalesce(title, '')) LIKE '%mvp%' THEN 2
           ELSE 3 END,
      length(coalesce(content, '')) DESC
    LIMIT 15
    `,
    [term, topic],
  );
}

/** True when SQL ETA answer has no roadmap/dates — chat pipeline should try RAG. */
export function isWeakProjectEtaAnswer(answer: string) {
  return (
    /No explicit completion date/i.test(answer) &&
    !/Product Charter|roadmap|Play Store|Stabilise|May|June|20\d{2}/i.test(answer)
  );
}

async function buildProjectEtaAnswer(topic: string): Promise<string | null> {
  const hubRows = await lookupByTitle(topic, true);
  const related = await findRelatedProjectPages(topic);
  const tokens = projectTopicTokens(topic);
  const seen = new Set<string>();
  const pages: Array<NotionPageRow & { content?: string | null }> = [];

  for (const row of [...hubRows, ...related]) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    pages.push(row);
  }

  if (!pages.length) return null;

  const hub = pages.find(
    (row) => (row.title ?? "").trim().toLowerCase() === topic.trim().toLowerCase(),
  ) ?? pages[0];

  const charterPage =
    pages.find((row) => /product charter|roadmap/i.test(row.title ?? "")) ?? null;
  const charterSection =
    (charterPage?.content ? extractCharterSection(charterPage.content, tokens) : null) ??
    pages.map((row) => extractCharterSection(row.content ?? "", tokens)).find(Boolean);

  const roadmapBullets = charterSection
    ? extractTimelineBullets(charterSection)
    : pages
        .flatMap((row) => extractTimelineBullets(extractPageBody(row.content, 600), 4))
        .slice(0, 6);

  const dateMentions = [
    ...new Set(
      pages.flatMap((row) =>
        extractDateMentions(`${row.title ?? ""}\n${extractPageBody(row.content, 2000)}`),
      ),
    ),
  ];

  const mvpPages = pages
    .filter((row) => /mvp|release|version|\d+\.\d+/i.test(row.title ?? ""))
    .slice(0, 5);

  const lines: string[] = [
    `## ETA — **${topic}**`,
    "",
    hub
      ? `**Hub:** ${formatLink(hub.title || topic, hub.url)} · **${hub.status || "not set"}**${hub.owner ? ` · ${hub.owner}` : ""}`
      : "",
  ];

  if (charterSection && roadmapBullets.length) {
    lines.push(
      "",
      "**Planned milestones** (from synced roadmap / Product Charter):",
      ...roadmapBullets.map((b) => `- ${b}`),
    );
  }

  if (dateMentions.length) {
    const { current, older } = partitionDateMentions(dateMentions);
    if (current.length) {
      lines.push("", "**Dates / targets (current / near-term):**", ...current.map((d) => `- ${d}`));
    }
    if (older.length) {
      lines.push(
        "",
        "**Older mentions (may be outdated):**",
        ...older.map((d) => `- ${d}`),
      );
    }
    if (!current.length && older.length) {
      lines.push(
        "",
        "_Only older dates found in sync — confirm the latest roadmap in Notion before relying on these._",
      );
    }
  }

  if (mvpPages.length) {
    lines.push("", "**Version / release pages:**");
    for (const row of mvpPages) {
      lines.push(
        `- ${formatLink(row.title || "Untitled", row.url)} — **${row.status || "not set"}**`,
      );
    }
  }

  const hasSubstance = charterSection || dateMentions.length > 0 || roadmapBullets.length > 0;
  if (!hasSubstance) {
    const body = extractPageBody(hub?.content, 500);
    if (body) {
      lines.push("", "**Page content:**", body);
    }
    lines.push(
      "",
      "_No fixed calendar ETA in synced Notion — only status on the hub page. Check project tracker databases in Notion for due dates._",
    );
    return isWeakProjectEtaAnswer(lines.join("\n")) ? null : lines.join("\n");
  }

  lines.push(
    "",
    dateMentions.length
      ? "_Use the dates above as the best ETA signals from synced Notion._"
      : "_No single due-date field — milestones above are the completion plan from synced Notion._",
  );

  const relatedLinks = pages
    .filter((row) => row.id !== hub?.id)
    .slice(0, 4)
    .map((row) => formatLink(row.title || "Untitled", row.url));

  if (relatedLinks.length) {
    lines.push("", `**Related pages:** ${relatedLinks.join(", ")}`);
  }

  return lines.filter((line) => line !== "").join("\n");
}

function stripTitleEmoji(title: string) {
  return title
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function lookupByTitle(title: string, includeContent = false) {
  const strippedTitle = stripTitleEmoji(title);
  const lookupTitles = [...new Set([title, strippedTitle].filter((t) => t.length > 0))];
  const term = `%${escapeLike(strippedTitle || title)}%`;
  const columns = includeContent
    ? "id, title, url, owner, created_by, last_edited_by, doc_type, status, content"
    : "id, title, url, owner, created_by, last_edited_by, doc_type, status";

  for (const lookupTitle of lookupTitles) {
    const exact = await query<NotionPageRow>(
      `
      SELECT ${columns}
      FROM notion_pages
      WHERE lower(trim(coalesce(title, ''))) = lower(trim($1))
      LIMIT 3
      `,
      [lookupTitle],
    );
    if (exact.length === 1) return exact;
  }

  const candidates = await query<NotionPageRow>(
    `
    SELECT ${columns}
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR to_tsvector('english', coalesce(title, '')) @@ plainto_tsquery('english', $2)
    LIMIT ${SQL_RESULT_LIMIT}
    `,
    [term, title],
  );

  if (!candidates.length) return [];

  const ranked = candidates
    .map((row) => ({ row, score: titleMatchScore(row.title || "", title) }))
    .filter((item) => item.score >= 200)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return [];
  if (ranked[0].score >= 800) return [ranked[0].row];
  return ranked.map((item) => item.row);
}

export async function handleMetadataQuery(parsed: ParsedQuery): Promise<string | null> {
  const personRaw = parsed.personName?.trim();
  const person = personRaw ? normalizePersonNameForMatch(personRaw) : undefined;
  const docTitle = parsed.docTitle?.trim();

  if (parsed.kind === "owner_list" && person) {
    const personTerm = `%${escapeLike(person)}%`;
    const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
    const projectsOwnedQuery = /\b(?:which|what)\s+projects?\s+.+\s+the\s+owner\s+of/i.test(parsed.raw);
    const singularProject = /\bwhich\s+project\s+/i.test(parsed.raw);

    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
      FROM notion_pages
      WHERE
        lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
      ORDER BY
        CASE
          WHEN lower(coalesce(status, '')) IN ('in development', 'in progress', 'testing', 'prod ready') THEN 0
          WHEN lower(coalesce(status, '')) = 'backlog' THEN 1
          ELSE 2
        END,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm],
    );
    if (!rows.length) return null;

    const seenTitles = new Set<string>();
    const uniqueRows = rows.filter((row) => {
      const key = (row.title || "").trim().toLowerCase();
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    const ownerName = uniqueRows[0]?.owner || person;
    const activeRows = uniqueRows.filter((row) =>
      /in development|in progress|testing|prod ready/i.test(row.status || ""),
    );
    const lines: string[] = [];

    if (singularProject && uniqueRows.length > 1) {
      const highlights = (activeRows.length ? activeRows : uniqueRows)
        .slice(0, 5)
        .map((row) => `**${row.title}**`)
        .join(", ");
      lines.push(
        `**${ownerName}** is listed as owner on **${uniqueRows.length}** projects in Notion — not just one. Active examples: ${highlights}.`,
        "",
      );
    } else if (singularProject && uniqueRows.length === 1) {
      const row = uniqueRows[0];
      lines.push(
        `**${ownerName}** is owner of **${formatLink(row.title || "Untitled", row.url)}**${row.status ? ` (status: ${row.status})` : ""}.`,
        "",
      );
    }

    const label = projectsOwnedQuery
      ? `project(s) where **${person}** is owner`
      : `page(s) owned by **${person}**`;

    lines.push(
      formatListHeader(uniqueRows.length, label),
      "",
      formatRows(uniqueRows, (row) => {
        const meta = [
          `owner: ${row.owner || "Unknown"}`,
          row.status ? `status: ${row.status}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `**${formatLink(row.title || "Untitled", row.url)}** — ${meta}`;
      }),
    );

    return lines.join("\n");
  }

  if (parsed.kind === "created_by_list" && person) {
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
      FROM notion_pages
      WHERE lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
      ORDER BY title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [`%${escapeLike(person)}%`],
    );
    if (!rows.length) return null;
    return `${formatListHeader(rows.length, `created by ${person}`)}\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — created by: ${row.created_by || "Unknown"}`,
    )}`;
  }

  if (parsed.kind === "assigned_list" && person) {
    const personTerm = `%${escapeLike(person)}%`;
    const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
    const normalizedTopic = docTitle ? normalizeTopic(docTitle) : "";
    const topicTerm = normalizedTopic ? `%${escapeLike(normalizedTopic)}%` : null;
    const year = parsed.year;
    const yearStart = year ? `${year}-01-01` : null;
    const yearEnd = year ? `${year + 1}-01-01` : null;
    const assigneeInContentSql = `
      (
        (
          lower(coalesce(content, '')) LIKE '%assignee:%'
          OR lower(coalesce(content, '')) LIKE '%assign:%'
          OR lower(coalesce(content, '')) LIKE '%assigned:%'
          OR lower(coalesce(content, '')) LIKE '%captain:%'
        )
        AND (
          lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
          OR regexp_replace(lower(coalesce(content, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        )
      )
    `;
    const rows = await query<NotionPageRow & { notion_edited_at?: string | null }>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content, notion_edited_at::text
      FROM notion_pages
      WHERE
        (
          lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
          OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
          OR ${assigneeInContentSql}
        )
        AND (
          $3::text IS NULL
          OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
          OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
        )
        AND (
          $4::text IS NULL
          OR (
            notion_edited_at IS NOT NULL
            AND notion_edited_at >= $4::timestamptz
            AND notion_edited_at < $5::timestamptz
          )
        )
      ORDER BY
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\' THEN 0
          ELSE 1
        END,
        notion_edited_at DESC NULLS LAST,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm, topicTerm, yearStart, yearEnd],
    );
    const yearNote = year ? ` in **${year}**` : "";
    if (!rows.length) {
      return (
        `No tasks or pages with **${person}** as owner or assignee${yearNote} in synced Notion.\n\n` +
        `_Check the exact name spelling in Notion (e.g. **Tamanna a**), or use **Sync changes** if assignments were updated recently._`
      );
    }

    if (asksForProjectsOnly(parsed.raw)) {
      return formatAssignedProjectsAnswer(person, rows, yearNote);
    }

    const listLabel = asksForTasksOnly(parsed.raw)
      ? `task(s) assigned to ${person}${yearNote}${docTitle ? ` matching "${docTitle}"` : ""}`
      : `page(s) assigned to ${person}${yearNote}${docTitle ? ` matching "${docTitle}"` : ""}`;

    return `${formatListHeader(rows.length, listLabel)}\n\n${formatRows(
      rows,
      (row) => {
        const edited =
          "notion_edited_at" in row && row.notion_edited_at
            ? String(row.notion_edited_at).slice(0, 10)
            : "";
        return formatCompactListItem(row, [
          row.owner ? `assignee: ${row.owner}` : "assignee: Unknown",
          edited ? `edited: ${edited}` : "",
        ].filter(Boolean));
      },
    )}`;
  }

  if (parsed.kind === "worked_on_list" && person) {
    const personTerm = `%${escapeLike(person)}%`;
    const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
    const effectiveTopic = docTitle && !isNoiseTopic(docTitle) ? docTitle : undefined;
    const normalizedTopic = effectiveTopic ? normalizeTopic(effectiveTopic) : "";
    const topicTerm = normalizedTopic ? `%${escapeLike(normalizedTopic)}%` : null;
    const taskListQuery = /\b(?:which|what)\s+tasks?\b/i.test(parsed.raw);

    const personPropertyInContentSql = `
      (
        (
          lower(coalesce(content, '')) LIKE '%captain:%'
          OR lower(coalesce(content, '')) LIKE '%assignee:%'
          OR lower(coalesce(content, '')) LIKE '%assign:%'
          OR lower(coalesce(content, '')) LIKE '%assigned:%'
        )
        AND lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      )
    `;

    const personFieldMatchSql = `
      (
        lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR ${personPropertyInContentSql}
      )
    `;

    const personMatchSql = topicTerm
      ? `
      (
        ${personFieldMatchSql}
        OR lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      )
    `
      : personFieldMatchSql;

    const rows = await query<WorkedOnRow>(
      `
      SELECT
        id,
        title,
        url,
        owner,
        created_by,
        last_edited_by,
        doc_type,
        status,
        content,
        notion_edited_at::text AS notion_edited_at,
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
            THEN 'owner'
          WHEN ${personPropertyInContentSql} THEN 'assignee'
          WHEN lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
            THEN 'creator'
          WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
            THEN 'last editor'
          ELSE 'mentioned'
        END AS match_source
      FROM notion_pages
      WHERE ${personMatchSql}
      AND (
        $3::text IS NULL
        OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
      )
      ORDER BY
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\' THEN 1
          WHEN ${personPropertyInContentSql} THEN 2
          WHEN lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\' THEN 3
          ELSE 9
        END,
        notion_edited_at DESC NULLS LAST,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm, topicTerm],
    );
    if (!rows.length) return null;

    const label = taskListQuery
      ? `${person} worked on`
      : `associated with ${person}${effectiveTopic ? ` and matching "${effectiveTopic}"` : ""}`;

    return `${formatListHeader(rows.length, label)}\n\n${formatRows(rows, (row) => {
      const who =
        row.match_source === "owner"
          ? `owner: ${row.owner || "Unknown"}`
          : row.match_source === "assignee"
            ? "assignee/captain"
            : row.match_source === "creator"
              ? `created by: ${row.created_by || "Unknown"}`
              : row.match_source === "last editor"
                ? `last edited by: ${row.last_edited_by || "Unknown"}`
                : "mentioned";
      const metadata = [
        who,
        row.status ? `status: ${row.status}` : "",
        row.notion_edited_at
          ? `last edited: ${new Date(row.notion_edited_at).toLocaleDateString()}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `**${formatLink(row.title || "Untitled", row.url)}** — ${metadata}`;
    })}`;
  }

  if (parsed.kind === "project_manager_of" && docTitle) {
    const normalizedTopic = normalizeTopic(docTitle);
    const topicTerm = `%${escapeLike(normalizedTopic || docTitle)}%`;
    const exactRows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content
      FROM notion_pages
      WHERE lower(coalesce(title, '')) = lower($1)
      LIMIT 1
      `,
      [normalizedTopic || docTitle],
    );

    if (exactRows.length) {
      const row = exactRows[0];
      const ownerName = row.owner?.trim();
      if (ownerName) {
        return row.url
          ? `${ownerName}\n\n${formatLink(row.title || docTitle, row.url)}`
          : ownerName;
      }
      return null;
    }

    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content
      FROM notion_pages
      WHERE
        (
          lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
          OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
        )
        AND (
          lower(coalesce(owner, '')) <> ''
          OR lower(coalesce(content, '')) LIKE '%project manager%'
          OR lower(coalesce(content, '')) LIKE '%project lead%'
          OR lower(coalesce(content, '')) LIKE '%manager:%'
          OR lower(coalesce(content, '')) LIKE '%pm:%'
          OR lower(coalesce(content, '')) LIKE '%owner:%'
        )
      ORDER BY
        CASE WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 0 ELSE 1 END,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [topicTerm],
    );
    if (!rows.length) return null;
    return `${formatListHeader(rows.length, `with possible project manager/lead info for "${docTitle}"`)}\n\n${formatRows(
      rows,
      (row) => {
        const metadata = [
          row.owner ? `owner/assignee: ${row.owner}` : "",
          row.status ? `status: ${row.status}` : "",
          row.doc_type ? `type: ${row.doc_type}` : "",
        ].filter(Boolean).join(" · ");
        const snippet = contentSnippet(row.content, 700);
        return `**${formatLink(row.title || "Untitled", row.url)}**${metadata ? ` — ${metadata}` : ""}${snippet ? `\n  ${snippet}` : ""}`;
      },
    )}`;
  }

  if (parsed.kind === "team_roster" && docTitle) {
    const scopeTopic = extractProjectScopeTopic(parsed.raw, docTitle);
    const pages = await fetchProjectPages(scopeTopic);
    const members = aggregatePeopleOnProject(pages);

    if (!members.length) {
      return [
        `### Team on **${scopeTopic}**`,
        "",
        `No people found in synced Notion for this project (checked **Owner**, **assignee/captain** lines, and **team roster** text in page content).`,
        "",
        `_Run **Sync changes**, or confirm pages mention the project name and list assignees in Notion._`,
      ].join("\n");
    }

    return [
      `### Who is working on **${scopeTopic}**`,
      "",
      `Found **${members.length}** people across **${pages.length}** related page(s) in Notion (owner, assignee, captain, team roster, editor — not only formal Owner):`,
      "",
      members
        .map((member, i) => {
          const roles = member.roles.length ? member.roles.join(", ") : "mentioned";
          return `${i + 1}. **${member.name}** — ${member.pageCount} page(s) — _${roles}_`;
        })
        .join("\n"),
      "",
      `_Re-sync if someone is missing. Ask **"Who is the most active team member in ${scopeTopic}?"** for a ranked view._`,
    ].join("\n");
  }

  if (parsed.kind === "team_activity" && docTitle) {
    const scopeTopic = extractProjectScopeTopic(parsed.raw, docTitle);
    const isLeastActive = /\b(least|lowest|bottom)\s+active\b/i.test(parsed.raw);
    const pages = await fetchProjectPages(scopeTopic);
    const members = aggregatePeopleOnProject(pages);
    const ranked = isLeastActive ? [...members].reverse() : members;

    if (!ranked.length) {
      return [
        `### ${isLeastActive ? "Least active" : "Most active"} in **${scopeTopic}**`,
        "",
        `Synced Notion pages for **${scopeTopic}** do not list people as owner, assignee, or in team roster text.`,
        "",
        `_Try **Sync changes**, or ask **"Who all are working on ${scopeTopic}?"** for the full team list._`,
      ].join("\n");
    }

    const top = ranked[0];
    return [
      `### ${isLeastActive ? "Least active" : "Most active"} in **${scopeTopic}** (by related Notion pages)`,
      "",
      `**${isLeastActive ? "Least active match" : "Top match"}:** **${top.name}** — ${top.pageCount} related page(s).`,
      "",
      ranked
        .slice(0, 15)
        .map((member, i) => {
          const roles = member.roles.slice(0, 3).join(", ");
          return `${i + 1}. **${member.name}** — ${member.pageCount} page(s)${roles ? ` _(${roles})_` : ""}`;
        })
        .join("\n"),
      "",
      `_Counts owner, assignee, captain, team roster, and editor signals on pages matching **${scopeTopic}**. Re-sync if data looks stale._`,
    ].join("\n");
  }

  if (parsed.kind === "blocker_list") {
    const applyScope = docTitle && !isWorkspaceScope(docTitle);
    const scopeTerm = applyScope ? `%${escapeLike(normalizeTopic(docTitle))}%` : null;
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, status, doc_type, content
      FROM notion_pages
      WHERE
        (
          lower(coalesce(status, '')) LIKE '%block%'
          OR lower(coalesce(status, '')) IN ('on hold', 'waiting', 'stuck')
        )
        ${scopeTerm ? `AND (lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\')` : ""}
      ORDER BY
        CASE WHEN lower(coalesce(status, '')) LIKE '%block%' THEN 0 ELSE 1 END,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      scopeTerm ? [scopeTerm] : [],
    );

    if (!rows.length) {
      return `No pages with **Blocked** or **On Hold** status found${docTitle && !isWorkspaceScope(docTitle) ? ` for "${docTitle}"` : " in synced Notion data"}.`;
    }

    return formatBlockerListAnswer(rows, docTitle);
  }

  if (parsed.kind === "project_eta" && docTitle) {
    return buildProjectEtaAnswer(docTitle);
  }

  if (parsed.kind === "project_summary" && docTitle) {
    return buildProjectSummary(docTitle);
  }

  if (parsed.kind === "compare_pages" && docTitle && parsed.compareTitleB) {
    return buildComparePages(docTitle, parsed.compareTitleB);
  }

  if (parsed.kind === "risks_for" && docTitle) {
    return buildRisksAnswer(docTitle);
  }

  if (parsed.kind === "onboarding_tasks") {
    return buildOnboardingTasksAnswer();
  }

  if (parsed.kind === "page_about" && docTitle) {
    const isCostQuestion = /\b(cost\s+estimation|cost\s+estimate|budget|pricing)\b/i.test(
      parsed.raw,
    );

    if (isCostQuestion) {
      const topicTerm = `%${escapeLike(docTitle)}%`;
      const costRows = await query<NotionPageRow & { content: string | null }>(
        `
        SELECT id, title, url, owner, created_by, doc_type, status, content
        FROM notion_pages
        WHERE
          (lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
           OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\')
          AND (
            lower(coalesce(title, '')) LIKE '%cost%'
            OR lower(coalesce(title, '')) LIKE '%budget%'
            OR lower(coalesce(content, '')) LIKE '%cost estimation%'
          )
        ORDER BY
          CASE WHEN lower(coalesce(title, '')) LIKE '%cost estimation%' THEN 0
               WHEN lower(coalesce(title, '')) LIKE '%cost%' THEN 1
               ELSE 2 END,
          length(coalesce(title, '')) ASC
        LIMIT 3
        `,
        [topicTerm],
      );
      if (costRows[0]) {
        return formatCostEstimationPage(costRows[0]);
      }
    }

    const rows = await lookupByTitle(docTitle, true);
    if (!rows.length) return pageNotSyncedMessage(docTitle);

    if (rows.length === 1) {
      const row = rows[0];
      if (isCostQuestion || /₹|cost estimation/i.test(row.content ?? "")) {
        return formatCostEstimationPage(row);
      }
      const { name: ownerName, label: ownerLabel } = resolvePageOwner(row);
      if (!row.owner && ownerName) row.owner = ownerName;
      return formatPageCard(row);
    }

    return `### ${rows.length} pages matching "${docTitle}"\n\n${formatRows(rows, (row) => {
      const snippet = contentSnippet(row.content, 220);
      return `**${formatLink(row.title || "Untitled", row.url)}**${snippet ? ` — ${snippet}` : ""}`;
    })}\n\n_Ask about one page by full title for a detailed summary._`;
  }

  if (parsed.kind === "topic_list" && docTitle) {
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
      FROM notion_pages
      WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      ORDER BY title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [`%${escapeLike(docTitle)}%`],
    );
    if (!rows.length) return null;
    return `### ${rows.length} docs matching "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** *(Status: ${row.status || "Unknown"} · Owner: ${row.owner || "Unknown"} · Created by: ${row.created_by || "Unknown"})*`,
    )}`;
  }

  if (parsed.kind === "owner_of" && docTitle) {
    const rows = await lookupByTitle(docTitle);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const row = rows[0];
      const { name, label } = resolvePageOwner(row);
      const note =
        label === "Created by" && !row.owner?.trim()
          ? " _(No Owner property on this page in Notion.)_"
          : "";
      return `**${label} of "${row.title || docTitle}":** ${name || "Unknown"}${note}${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) => {
        const { name, label } = resolvePageOwner(row);
        return `**${formatLink(row.title || "Untitled", row.url)}** — ${label}: **${name || "Unknown"}**`;
      },
    )}`;
  }

  if (parsed.kind === "created_by_of" && docTitle) {
    const rows = await lookupByTitle(docTitle);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const row = rows[0];
      return `**"${row.title || docTitle}"** was created by: **${row.created_by || "Unknown"}**${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — Created by: **${row.created_by || "Unknown"}**`,
    )}`;
  }

  if (parsed.kind === "assigned_to_of" && docTitle) {
    const rows = await lookupByTitle(docTitle);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const row = rows[0];
      const assignedTo = row.owner || null;
      const fallbackDetails = [
        row.created_by ? `Created by: **${row.created_by}**` : "",
        row.last_edited_by ? `Last edited by: **${row.last_edited_by}**` : "",
        row.status ? `Status: **${row.status}**` : "",
      ].filter(Boolean);

      if (assignedTo) {
        return `**"${row.title || docTitle}"** is assigned to: **${assignedTo}**${
          row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
        }`;
      }

      return `I found **"${row.title || docTitle}"**, but no assignee/owner property is stored for this page.\n\n${fallbackDetails.join(
        "\n",
      )}${row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""}`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — Assigned/Owner: **${row.owner || "Not stored"}**`,
    )}`;
  }

  if (parsed.kind === "type_of" && docTitle) {
    const rows = await lookupByTitle(docTitle);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const row = rows[0];
      return `**Type of "${row.title || docTitle}":** ${row.doc_type || "Unknown"}${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — Type: **${row.doc_type || "Unknown"}**`,
    )}`;
  }

  if (parsed.kind === "status_of" && docTitle) {
    const rows = await lookupProjectStatusPages(docTitle);
    if (!rows.length) return null;

    const withStatus = rows.filter((row) => row.status?.trim());
    const header = `### Progress on **${docTitle}** (${rows.length} related page(s) in Notion)`;

    if (rows.length === 1) {
      const row = rows[0];
      const meta = [
        row.status ? `Status: **${row.status}**` : "Status: _not set_",
        row.owner ? `Owner: ${row.owner}` : "",
        row.created_by ? `Created by: ${row.created_by}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `${header}\n\n**${formatLink(row.title || docTitle, row.url)}** — ${meta}${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }

    const statusNote =
      withStatus.length > 0
        ? `_Statuses below come from Notion page properties (not AI inference)._`
        : `_No Status field stored on these pages — try opening the main project page in Notion._`;

    return `${header}\n\n${statusNote}\n\n${formatRows(rows, (row) => {
      const meta = [
        row.status ? `status: **${row.status}**` : "status: _not set_",
        row.owner ? `owner: ${row.owner}` : "",
        row.doc_type ? `type: ${row.doc_type}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `**${formatLink(row.title || "Untitled", row.url)}** — ${meta}`;
    })}`;
  }

  if (parsed.kind === "activity_summary" && person) {
    const personTerm = `%${escapeLike(person)}%`;
    const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
    const normalizedTopic = docTitle ? normalizeTopic(docTitle) : "";
    const topicTerm = normalizedTopic ? `%${escapeLike(normalizedTopic)}%` : null;
    const year = parsed.year;
    const yearStart = year ? `${year}-01-01` : null;
    const yearEnd = year ? `${year + 1}-01-01` : null;
    const workingOnQuery = /\bworking\s+on\b|\bworking\s+currently\b/i.test(parsed.raw);
    const projectNameQuery = wantsProjectNameAnswer(parsed.raw);

    const personPropertyInContentSql = `
      (
        (
          lower(coalesce(content, '')) LIKE '%captain:%'
          OR lower(coalesce(content, '')) LIKE '%assignee:%'
          OR lower(coalesce(content, '')) LIKE '%assign:%'
        )
        AND lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      )
    `;

    const personMatchSql = `
      (
        lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
        OR ${personPropertyInContentSql}
      )
    `;

    const topicFilterSql = `
      (
        $3::text IS NULL
        OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
      )
    `;

    const yearFilterSql = `
      (
        $4::text IS NULL
        OR (
          notion_edited_at IS NOT NULL
          AND notion_edited_at >= $4::timestamptz
          AND notion_edited_at < $5::timestamptz
        )
      )
    `;

    const statusRankSql = `
      CASE lower(trim(coalesce(status, '')))
        WHEN 'in progress' THEN 1
        WHEN 'testing' THEN 2
        WHEN 'scoping' THEN 3
        WHEN 'not started' THEN 4
        WHEN 'blocked' THEN 5
        WHEN 'on hold' THEN 6
        WHEN 'done' THEN 99
        ELSE 50
      END
    `;

    const historicalWork = isHistoricalWorkQuery(parsed.raw);
    const listAllProjects = wantsAllProjectsList(parsed.raw);
    const rowLimit =
      year && (historicalWork || listAllProjects) ? HISTORICAL_PROJECT_LIMIT : SQL_RESULT_LIMIT;

    const orderSql =
      historicalWork && year
        ? `notion_edited_at DESC NULLS LAST, role_rank ASC, title ASC`
        : workingOnQuery
          ? `role_rank ASC, status_rank ASC, notion_edited_at DESC NULLS LAST, title ASC`
          : `role_rank ASC, notion_edited_at DESC NULLS LAST, title ASC`;

    async function fetchActivityRows(requireYear: boolean) {
      return query<ActivityRow>(
        `
        SELECT
          id,
          title,
          url,
          owner,
          created_by,
          last_edited_by,
          doc_type,
          status,
          left(coalesce(content, ''), 2500) AS content,
          notion_edited_at::text AS notion_edited_at,
          CASE
            WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
              THEN 'owner'
            WHEN ${personPropertyInContentSql}
              THEN 'captain/assignee'
            WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
              THEN 'last editor'
            ELSE 'creator'
          END AS activity_role,
          CASE
            WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
              THEN 1
            WHEN ${personPropertyInContentSql}
              THEN 2
            WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2::text ESCAPE '\\'
              THEN 3
            ELSE 4
          END AS role_rank,
          ${statusRankSql} AS status_rank
        FROM notion_pages
        WHERE ${personMatchSql} AND ${topicFilterSql}
          AND (
            $6::boolean = false
            OR ${yearFilterSql}
          )
        ORDER BY ${orderSql}
        LIMIT ${rowLimit}
        `,
        [
          personTerm,
          fuzzyPersonTerm,
          topicTerm,
          requireYear ? yearStart : null,
          requireYear ? yearEnd : null,
          requireYear,
        ],
      );
    }

    let primaryRows = await fetchActivityRows(Boolean(year));
    let usedYearFallback = false;
    if (!primaryRows.length && year && workingOnQuery) {
      primaryRows = await fetchActivityRows(false);
      primaryRows = primaryRows.filter((row) => isActiveStatus(row.status));
      usedYearFallback = primaryRows.length > 0;
    }

    const rows = primaryRows.length
      ? primaryRows
      : await query<ActivityRow>(
          `
          SELECT
            id,
            title,
            url,
            owner,
            created_by,
            last_edited_by,
            doc_type,
            status,
            notion_edited_at::text AS notion_edited_at,
            'mentioned in page text' AS activity_role,
            9 AS role_rank,
            50 AS status_rank
          FROM notion_pages
          WHERE
            lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
            AND (
              $2::text IS NULL
              OR lower(coalesce(title, '')) LIKE lower($2) ESCAPE '\\'
              OR lower(coalesce(content, '')) LIKE lower($2) ESCAPE '\\'
            )
            AND (
              $3::text IS NULL
              OR (
                notion_edited_at IS NOT NULL
                AND notion_edited_at >= $3::timestamptz
                AND notion_edited_at < $4::timestamptz
              )
            )
          ORDER BY status_rank ASC, notion_edited_at DESC NULLS LAST, title ASC
          LIMIT ${SQL_RESULT_LIMIT}
          `,
          [personTerm, topicTerm, yearStart, yearEnd],
        );

    if (!rows.length) {
      const yearNote = year ? ` in **${year}**` : "";
      return `I couldn't find any Notion pages linked to **${person}**${yearNote}${docTitle ? ` for "${docTitle}"` : ""}. Try **Sync changes** if data is stale, or ask **"What projects is ${person} assigned to?"**`;
    }

    const topicNote = docTitle ? ` (filtered by "${docTitle}")` : "";
    const yearNote = year ? ` in **${year}**` : "";
    const activeRows = rows.filter((row) => isActiveStatus(row.status));
    const top = (workingOnQuery && activeRows.length ? activeRows : rows)[0];
    const editedLabel = top.notion_edited_at
      ? new Date(top.notion_edited_at).toLocaleDateString()
      : "date not stored — re-sync to refresh";

    const usedMentionsOnly = primaryRows.length === 0;
    const yearRows = year
      ? rows.filter((row) => row.notion_edited_at?.startsWith(String(year)))
      : rows;
    const ownerRows = rows.filter((row) => row.activity_role === "owner");
    const themeSource = ownerRows.length ? ownerRows : rows.slice(0, 10);
    const projectTheme = inferProjectTheme(themeSource);
    const hubPage =
      projectTheme && collectProjectThemes(themeSource).filter((t) => t === projectTheme).length >= 2
        ? await lookupProjectHubPage(projectTheme)
        : null;

    if (projectNameQuery) {
      const yearActive = yearRows.filter((row) => isActiveStatus(row.status));
      const yearWorked = historicalWork ? yearRows : yearActive;
      const lines: string[] = [];

      // Year-scoped project questions — only use pages edited in that calendar year
      if (year) {
        if (!yearWorked.length) {
          const noWorkLabel = historicalWork
            ? `has **not worked on any project**`
            : `has **no project assigned**`;
          lines.push(
            `In **${year}**, **${person}** ${noWorkLabel} in synced Notion data (no owner, creator, assignee, or captain pages edited that year).`,
          );

          if (!historicalWork && yearRows.length) {
            const doneOnly = yearRows.filter((row) => !isActiveStatus(row.status));
            if (doneOnly.length) {
              lines.push(
                "",
                `_Related pages in ${year} are completed or released only (not current assignments):_`,
              );
              for (const row of doneOnly.slice(0, 3)) {
                lines.push(`- ${formatActivityRowLine(row)}`);
              }
            }
          }

          lines.push("", `_Use **Sync changes** if Notion was updated recently._`);
          return lines.join("\n");
        }

        const themes = collectProjectThemes(yearWorked);

        if (listAllProjects) {
          lines.push(
            `In **${year}**, **${person}** worked on **${themes.length || 1}** project area(s) in synced Notion data:`,
          );
          if (themes.length) {
            for (const theme of themes) {
              const hub = await lookupProjectHubPage(theme);
              lines.push(
                hub
                  ? `- **${theme}** — ${formatLink(hub.title || theme, hub.url)}`
                  : `- **${theme}**`,
              );
            }
          } else {
            lines.push(`- _(project name unclear — see tasks below)_`);
          }
          lines.push("", `**${yearWorked.length} related page(s):**`);
          for (const row of yearWorked.slice(0, 8)) {
            lines.push(`- ${formatActivityRowLine(row)}`);
          }
          if (yearWorked.length > 8) {
            lines.push("", `_+${yearWorked.length - 8} more pages in Notion._`);
          }
          return lines.join("\n");
        }

        const yearTheme = themes[0] ?? inferProjectTheme(yearWorked);
        const yearHub = yearTheme ? await lookupProjectHubPage(yearTheme) : null;
        const hubLine = yearHub
          ? formatLink(yearHub.title || yearTheme || "Project", yearHub.url)
          : yearTheme;

        const verb = historicalWork ? "worked on" : "is working on";
        lines.push(
          hubLine
            ? `In **${year}**, **${person}** ${verb} **${yearTheme}** (${hubLine}).`
            : `In **${year}**, **${person}** ${verb} **${yearWorked.length}** related page(s) in synced Notion data.`,
        );

        if (themes.length > 1) {
          lines.push(
            "",
            `_Also touched: ${themes.slice(1, 4).join(", ")}${themes.length > 4 ? "…" : ""}._`,
          );
        }

        lines.push("", historicalWork ? "**Pages in that year:**" : "**Assigned in that year:**");
        for (const row of yearWorked.slice(0, 6)) {
          lines.push(`- ${formatActivityRowLine(row)}`);
        }
        return lines.join("\n");
      }

      // No year — use owner pages; do not invent a hub from mention-only rows
      const ownerActive = (workingOnQuery && activeRows.length ? activeRows : rows).filter(
        (row) => row.activity_role === "owner",
      );
      const displayRows = (ownerActive.length ? ownerActive : ownerRows.length ? ownerRows : rows).slice(
        0,
        4,
      );
      const focusRow = displayRows[0];
      const themes = collectProjectThemes(themeSource);

      if (focusRow) {
        const focusMeta = [
          focusRow.status ? focusRow.status : "",
          focusRow.notion_edited_at
            ? `last edited ${new Date(focusRow.notion_edited_at).toLocaleDateString()}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        lines.push(
          `**${person}** — strongest focus in synced Notion: **${formatLink(focusRow.title || "Untitled", focusRow.url)}**${focusMeta ? ` (${focusMeta})` : ""}.`,
        );
        if (themes.length > 1) {
          lines.push(`_Also associated with: ${themes.slice(0, 4).join(", ")}._`);
        } else if (hubPage && projectTheme) {
          lines.push(
            `_Broader area: **${projectTheme}** — ${formatLink(hubPage.title || projectTheme, hubPage.url)}._`,
          );
        }
      } else if (!activeRows.length && !ownerRows.length) {
        lines.push(`**${person}** has **no active project assigned** in synced Notion data.`);
        return lines.join("\n");
      } else {
        lines.push(`**${person}** — see owned/assigned pages below (no single hub page inferred).`);
      }

      if (displayRows.length) {
        lines.push("", "**Active / recent tasks:**");
        for (const row of displayRows) {
          lines.push(`- ${formatActivityRowLine(row)}`);
        }
        if ((activeRows.length || rows.length) > displayRows.length) {
          lines.push(
            "",
            `_+${(activeRows.length || rows.length) - displayRows.length} more — ask "What projects is ${person} assigned to?" for the full list._`,
          );
        }
      }

      return lines.join("\n");
    }

    let summary: string;
    if (usedMentionsOnly) {
      summary = `No pages where **${person}** is owner, creator, or last editor${topicNote}${yearNote}. Below: pages that only **mention** the name (weaker signal).`;
    } else if (year && !usedYearFallback && yearRows.length === 0) {
      summary = `No Notion edits for **${person}** were recorded in **${year}** in synced data.`;
    } else if (usedYearFallback) {
      summary = [
        `No pages for **${person}** were edited in Notion during **${year}** in synced data.`,
        projectTheme
          ? `**Likely project:** ${projectTheme}${hubPage ? ` — ${formatLink(hubPage.title || projectTheme, hubPage.url)}` : ""}.`
          : `**Current in-progress work** (last known): **${top.title || "Untitled"}** — **${top.status || "unknown"}**, last edited ${editedLabel}.`,
      ].join(" ");
    } else if (workingOnQuery && activeRows.length) {
      const activeList = activeRows
        .slice(0, 5)
        .map((row) => `**${row.title || "Untitled"}** (${row.status})`)
        .join(", ");
      summary = projectTheme
        ? `**${person}** is working on **${projectTheme}**${yearNote}: ${activeList}${activeRows.length > 5 ? ` (+${activeRows.length - 5} more tasks)` : ""}.`
        : `**${person}** is working on (in progress / active)${yearNote}${topicNote}: ${activeList}${activeRows.length > 5 ? ` (+${activeRows.length - 5} more)` : ""}.`;
    } else {
      summary = `**Strongest match for ${person}**${topicNote}${yearNote}: **${top.title || "Untitled"}** (${top.activity_role}, last edited in Notion: ${editedLabel}).`;
    }

    const listLabel = workingOnQuery
      ? usedYearFallback
        ? "in-progress page(s) (no edits in that year — last known from Notion)"
        : `page(s)${yearNote}`
      : `page(s)${yearNote}`;

    const listCap = workingOnQuery ? 8 : SQL_RESULT_LIMIT;

    return `${summary}\n\n### ${rows.length} ${listLabel}\n\n${formatRows(rows.slice(0, listCap), (row) => {
      const meta = [
        row.activity_role ? `role: ${row.activity_role}` : "",
        row.owner ? `owner: ${row.owner}` : "",
        row.last_edited_by ? `last edited by: ${row.last_edited_by}` : "",
        row.created_by ? `created by: ${row.created_by}` : "",
        row.status ? `status: ${row.status}` : "",
        row.notion_edited_at
          ? `last edited in Notion: ${new Date(row.notion_edited_at).toLocaleDateString()}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `**${formatLink(row.title || "Untitled", row.url)}** — ${meta}`;
    })}`;
  }

  return null;
}
