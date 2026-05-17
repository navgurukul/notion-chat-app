import { query } from "@/lib/postgres";
import type { ParsedQuery } from "@/lib/query-router";

type NotionPageRow = {
  id: string;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  doc_type: string | null;
  status: string | null;
  content?: string | null;
  match_source?: string | null;
};

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

function escapeLike(value: string) {
  return value.replace(/[%_]/g, "\\$&");
}

/** Direct Notion URL lookup by page title (exact, then partial). */
export async function lookupPageLinkByTitle(docTitle: string): Promise<string | null> {
  const trimmed = docTitle.trim();
  if (trimmed.length < 2) return null;

  const exact = await query<NotionPageRow>(
    `
    SELECT id, title, url
    FROM notion_pages
    WHERE lower(coalesce(title, '')) = lower($1)
    LIMIT 1
    `,
    [trimmed],
  );
  const row =
    exact[0] ??
    (
      await query<NotionPageRow>(
        `
        SELECT id, title, url
        FROM notion_pages
        WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
        ORDER BY length(coalesce(title, '')) ASC, title ASC
        LIMIT 1
        `,
        [`%${escapeLike(trimmed)}%`],
      )
    )[0];

  if (!row) return null;
  if (!row.url) {
    return `Found **${row.title || "Untitled"}**, but no Notion URL is stored for it.`;
  }
  return `**${row.title || "Untitled"}**\n\n[Open in Notion](${row.url})`;
}

function formatListHeader(count: number, label: string) {
  return `### ${count} doc(s) ${label}`;
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

function contentSnippet(content?: string | null, maxLength = 450) {
  const cleaned = (content || "")
    .replace(/=== PROPERTIES ===|=== CONTENT ===/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

const PROJECT_THEMES = [
  {
    name: "Reports and Dashboards",
    hubTitleLike: "%reports and dashboard%",
    signals: [/report/i, /dashboard/i, /pdf/i, /executive/i, /pagination/i, /widget/i, /key-insight/i],
  },
  {
    name: "Role-based access & platform",
    hubTitleLike: "%role%",
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
] as const;

function wantsProjectNameAnswer(raw: string) {
  return /\b(?:which|what|all)\b[\s\S]*\bprojects?\b/i.test(raw);
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

function inferProjectTheme(rows: Array<{ title?: string | null; content?: string | null }>) {
  const combined = rows
    .map((row) => `${row.title ?? ""} ${(row.content ?? "").slice(0, 600)}`)
    .join(" ")
    .toLowerCase();

  let best: { name: string; score: number } | null = null;
  for (const theme of PROJECT_THEMES) {
    const score = theme.signals.reduce((n, pattern) => n + (pattern.test(combined) ? 1 : 0), 0);
    const minScore = theme.name === "Reports and Dashboards" ? 2 : 1;
    if (score >= minScore && (!best || score > best.score)) best = { name: theme.name, score };
  }
  return best?.name ?? null;
}

function collectProjectThemes(rows: Array<{ title?: string | null; content?: string | null }>) {
  const scores = new Map<string, number>();
  for (const row of rows) {
    const theme = inferProjectTheme([row]);
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
    ORDER BY
      CASE WHEN lower(trim(title)) = lower(trim($2)) THEN 0 END,
      CASE WHEN lower(title) LIKE '%release%' THEN 1 ELSE 2 END,
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
  const term = `%${escapeLike(topic)}%`;
  return query<NotionPageRow>(
    `
    SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR to_tsvector('english', coalesce(title, '')) @@ plainto_tsquery('english', $2)
    ORDER BY
      CASE WHEN lower(coalesce(title, '')) = lower($2) THEN 0 ELSE 1 END,
      CASE WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 0 ELSE 1 END,
      length(coalesce(title, '')) ASC,
      title ASC
    LIMIT ${SQL_RESULT_LIMIT}
    `,
    [term, topic],
  );
}

async function lookupByTitle(title: string, includeContent = false) {
  const term = `%${escapeLike(title)}%`;
  const columns = includeContent
    ? "id, title, url, owner, created_by, last_edited_by, doc_type, status, content"
    : "id, title, url, owner, created_by, last_edited_by, doc_type, status";

  const exact = await query<NotionPageRow>(
    `
    SELECT ${columns}
    FROM notion_pages
    WHERE lower(trim(coalesce(title, ''))) = lower(trim($1))
    LIMIT 3
    `,
    [title],
  );
  if (exact.length === 1) return exact;

  return query<NotionPageRow>(
    `
    SELECT ${columns}
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR to_tsvector('english', coalesce(title, '')) @@ plainto_tsquery('english', $2)
    ORDER BY
      CASE WHEN lower(coalesce(title, '')) = lower($2) THEN 0 ELSE 1 END,
      length(coalesce(title, '')) ASC,
      ts_rank(to_tsvector('english', coalesce(title, '')), plainto_tsquery('english', $2)) DESC,
      title ASC
    LIMIT ${SQL_RESULT_LIMIT}
    `,
    [term, title],
  );
}

export async function handleMetadataQuery(parsed: ParsedQuery): Promise<string | null> {
  const person = parsed.personName?.trim();
  const docTitle = parsed.docTitle?.trim();

  if (parsed.kind === "owner_list" && person) {
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
      FROM notion_pages
      WHERE lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
      ORDER BY title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [`%${escapeLike(person)}%`],
    );
    if (!rows.length) return null;
    return `${formatListHeader(rows.length, `owned by ${person}`)}\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — owner: ${row.owner || "Unknown"}`,
    )}`;
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
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status, content
      FROM notion_pages
      WHERE
        (
          lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
          OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        )
        AND (
          $3::text IS NULL
          OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
          OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
        )
      ORDER BY title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm, topicTerm],
    );
    if (!rows.length) return null;
    return `${formatListHeader(rows.length, `assigned to ${person}${docTitle ? ` and matching "${docTitle}"` : ""}`)}\n\n${formatRows(
      rows,
      (row) => {
        const metadata = [
          `owner/assignee: ${row.owner || "Unknown"}`,
          row.status ? `status: ${row.status}` : "",
          row.doc_type ? `type: ${row.doc_type}` : "",
        ].filter(Boolean).join(" · ");
        const snippet = docTitle ? contentSnippet(row.content) : "";
        return `**${formatLink(row.title || "Untitled", row.url)}** — ${metadata}${snippet ? `\n  ${snippet}` : ""}`;
      },
    )}`;
  }

  if (parsed.kind === "worked_on_list" && person) {
    const personTerm = `%${escapeLike(person)}%`;
    const fuzzyPersonTerm = `%${escapeLike(stripVowels(person))}%`;
    const normalizedTopic = docTitle ? normalizeTopic(docTitle) : "";
    const topicTerm = normalizedTopic ? `%${escapeLike(normalizedTopic)}%` : null;
    const rows = await query<NotionPageRow>(
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
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\' THEN 'owner'
          WHEN lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\' THEN 'created_by'
          WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\' THEN 'last_edited_by'
          WHEN lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' THEN 'title'
          WHEN lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\' THEN 'content'
          WHEN regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\' THEN 'owner'
          WHEN regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\' THEN 'created_by'
          WHEN regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\' THEN 'last_edited_by'
          WHEN regexp_replace(lower(coalesce(title, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\' THEN 'title'
          ELSE 'content'
        END AS match_source
      FROM notion_pages
      WHERE
      (
        lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(title, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(content, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
      )
      AND (
        $3::text IS NULL
        OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
      )
      ORDER BY title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm, topicTerm],
    );
    if (!rows.length) return null;
    const includeDetails = Boolean(docTitle) || rows.length <= 20;
    return `${formatListHeader(rows.length, `associated with ${person}${docTitle ? ` and matching "${docTitle}"` : ""}`)}\n\n${formatRows(
      rows,
      (row) => {
        const who =
          row.match_source === "owner"
            ? `owner/assignee: ${row.owner || "Unknown"}`
            : row.match_source === "created_by"
              ? `created by: ${row.created_by || "Unknown"}`
              : row.match_source === "last_edited_by"
                ? `last edited by: ${row.last_edited_by || "Unknown"}`
                : row.match_source === "title"
                  ? "name mentioned in title"
                  : "name mentioned in content";
        const metadata = [
          who,
          row.status ? `status: ${row.status}` : "",
          row.doc_type ? `type: ${row.doc_type}` : "",
        ].filter(Boolean).join(" · ");
        const snippet = includeDetails ? contentSnippet(row.content) : "";
        return `**${formatLink(row.title || "Untitled", row.url)}** — ${metadata}${snippet ? `\n  ${snippet}` : ""}`;
      },
    )}`;
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
      if (row.owner?.trim()) return row.owner.trim();
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

  if (parsed.kind === "team_activity" && docTitle) {
    const topicTerm = `%${escapeLike(docTitle)}%`;
    type TeamRow = { last_edited_by: string; owner: string | null; edit_count: string };
    const byEditor = await query<TeamRow>(
      `
      SELECT
        person AS last_edited_by,
        max(owner) AS owner,
        COUNT(*)::text AS edit_count
      FROM (
        SELECT
          coalesce(nullif(trim(last_edited_by), ''), nullif(trim(owner), ''), 'Unknown') AS person,
          owner
        FROM notion_pages
        WHERE
          lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
          OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
      ) scoped
      WHERE person <> 'Unknown'
      GROUP BY person
      ORDER BY COUNT(*) DESC
      LIMIT 10
      `,
      [topicTerm],
    );

    if (!byEditor.length) {
      return `No activity signals found for workspace/topic **${docTitle}** in synced Notion data (no owner/last-editor fields on matching pages). Try **Sync changes** to refresh metadata.`;
    }

    const top = byEditor[0];
    return [
      `### Most active in **${docTitle}** (by pages owned/edited in Notion)`,
      "",
      `**Top match:** **${top.last_edited_by}** — ${top.edit_count} related page(s) in the index.`,
      "",
      byEditor
        .map((row, i) => `${i + 1}. **${row.last_edited_by}** — ${row.edit_count} page(s)`)
        .join("\n"),
      "",
      `_Based on Notion owner / last-edited-by fields on pages mentioning "${docTitle}". Re-sync if dates look stale._`,
    ].join("\n");
  }

  if (parsed.kind === "blocker_list") {
    const scopeTerm = docTitle ? `%${escapeLike(docTitle)}%` : null;
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, status, doc_type, content
      FROM notion_pages
      WHERE
        lower(coalesce(status, '')) LIKE '%block%'
        OR lower(coalesce(status, '')) IN ('on hold', 'waiting', 'stuck')
        OR lower(coalesce(title, '')) LIKE '%blocker%'
        OR lower(coalesce(content, '')) LIKE '%ship blocker%'
        OR lower(coalesce(content, '')) LIKE '%blocker comments%'
        ${scopeTerm ? `AND (lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\' OR lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\')` : ""}
      ORDER BY
        CASE WHEN lower(coalesce(status, '')) LIKE '%block%' THEN 0 ELSE 1 END,
        title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      scopeTerm ? [scopeTerm] : [],
    );

    if (!rows.length) {
      return `No pages with explicit **blocker** status or blocker mentions found${docTitle ? ` for "${docTitle}"` : ""} in synced Notion data.`;
    }

    return `${formatListHeader(rows.length, `possible blockers / open issues${docTitle ? ` (${docTitle})` : ""}`)}\n\n${formatRows(
      rows,
      (row) => {
        const snippet = contentSnippet(row.content, 280);
        return `**${formatLink(row.title || "Untitled", row.url)}** — status: **${row.status || "not set"}**${row.owner ? ` · owner: ${row.owner}` : ""}${snippet ? `\n  ${snippet}` : ""}`;
      },
    )}`;
  }

  if (parsed.kind === "project_eta" && docTitle) {
    const rows = await lookupByTitle(docTitle, true);
    if (!rows.length) return null;

    const lines = rows.slice(0, 8).map((row) => {
      const body = extractPageBody(row.content, 800);
      const dueMatch = (row.content || "").match(/due[^:\n]*:\s*([^\n]+)/i);
      const dateMatch = (row.content || "").match(
        /(?:target|launch|release|completion|deadline)[^:\n]*:\s*([^\n]+)/i,
      );
      const eta = dueMatch?.[1]?.trim() || dateMatch?.[1]?.trim();
      return [
        `**${formatLink(row.title || "Untitled", row.url)}**`,
        `Status: **${row.status || "not set"}**`,
        row.owner ? `Owner: ${row.owner}` : "",
        eta ? `Date in page: ${eta}` : "_No ETA/deadline field found on this page_",
        body ? `\n${body.slice(0, 400)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });

    return [
      `### ETA / completion — **${docTitle}**`,
      "",
      `_No single workspace-wide ETA is stored unless Notion pages include due dates. Related pages:_`,
      "",
      lines.join("\n\n---\n\n"),
      "",
      rows.some((r) => (r.content || "").match(/due|deadline|eta|completion date/i))
        ? ""
        : "\n**No explicit completion date** found in synced content for this project. Check the linked Notion pages or project tracker databases.",
    ].join("\n");
  }

  if (parsed.kind === "page_about" && docTitle) {
    const rows = await lookupByTitle(docTitle, true);
    if (!rows.length) return null;

    if (rows.length === 1) {
      const row = rows[0];
      const body = extractPageBody(row.content);
      const meta = [
        row.owner ? `Owner: ${row.owner}` : "",
        row.status ? `Status: ${row.status}` : "",
        row.doc_type ? `Type: ${row.doc_type}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      return [
        `## ${row.title || docTitle}`,
        meta ? `_${meta}_` : "",
        "",
        body || "_No page body stored yet — try **Sync changes** to refresh content._",
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n");
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
      return `**Owner of "${row.title || docTitle}":** ${row.owner || "Unknown"}${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — Owner: **${row.owner || "Unknown"}**`,
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
    const workingOnQuery = /\bworking\s+on\b/i.test(parsed.raw);
    const projectNameQuery = wantsProjectNameAnswer(parsed.raw);

    type ActivityRow = NotionPageRow & {
      notion_edited_at: string | null;
      activity_role: string | null;
      role_rank: number;
      status_rank: number;
      content?: string | null;
    };

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
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
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
              OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
              THEN 'owner'
            WHEN ${personPropertyInContentSql}
              THEN 'captain/assignee'
            WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
              THEN 'last editor'
            ELSE 'creator'
          END AS activity_role,
          CASE
            WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
              THEN 1
            WHEN ${personPropertyInContentSql}
              THEN 2
            WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
              OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
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
            AND ${topicFilterSql}
            AND (
              $4::text IS NULL
              OR (
                notion_edited_at IS NOT NULL
                AND notion_edited_at >= $4::timestamptz
                AND notion_edited_at < $5::timestamptz
              )
            )
          ORDER BY status_rank ASC, notion_edited_at DESC NULLS LAST, title ASC
          LIMIT ${SQL_RESULT_LIMIT}
          `,
          [personTerm, fuzzyPersonTerm, topicTerm, yearStart, yearEnd],
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
    const projectTheme = inferProjectTheme(activeRows.length ? activeRows : rows);
    const hubPage = projectTheme ? await lookupProjectHubPage(projectTheme) : null;

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

      // No year — use all-time active work
      const displayRows = (workingOnQuery && activeRows.length ? activeRows : rows).slice(0, 4);
      const hubLine = hubPage
        ? formatLink(hubPage.title || projectTheme || "Project", hubPage.url)
        : projectTheme
          ? `**${projectTheme}**`
          : null;

      if (hubLine && projectTheme) {
        lines.push(`**${person}** is working on **${projectTheme}** (${hubLine}).`);
      } else if (projectTheme) {
        lines.push(`**${person}** is working on **${projectTheme}**.`);
      } else if (!activeRows.length) {
        lines.push(`**${person}** has **no active project assigned** in synced Notion data.`);
        return lines.join("\n");
      } else {
        lines.push(`**${person}** — project name could not be inferred from task titles.`);
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
