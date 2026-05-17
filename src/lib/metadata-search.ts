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

    type ActivityRow = NotionPageRow & {
      notion_edited_at: string | null;
      activity_role: string | null;
      role_rank: number;
    };

    const personMatchSql = `
      (
        lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(created_by, '')) LIKE lower($1) ESCAPE '\\'
        OR lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
        OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(created_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
        OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
      )
    `;

    const topicFilterSql = `
      (
        $3::text IS NULL
        OR lower(coalesce(title, '')) LIKE lower($3) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($3) ESCAPE '\\'
      )
    `;

    const primaryRows = await query<ActivityRow>(
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
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
            THEN 'owner'
          WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
            THEN 'last editor'
          ELSE 'creator'
        END AS activity_role,
        CASE
          WHEN lower(coalesce(owner, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(owner, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
            THEN 1
          WHEN lower(coalesce(last_edited_by, '')) LIKE lower($1) ESCAPE '\\'
            OR regexp_replace(lower(coalesce(last_edited_by, '')), '[aeiou]', '', 'g') LIKE $2 ESCAPE '\\'
            THEN 2
          ELSE 3
        END AS role_rank
      FROM notion_pages
      WHERE ${personMatchSql} AND ${topicFilterSql}
      ORDER BY role_rank ASC, notion_edited_at DESC NULLS LAST, title ASC
      LIMIT ${SQL_RESULT_LIMIT}
      `,
      [personTerm, fuzzyPersonTerm, topicTerm],
    );

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
            9 AS role_rank
          FROM notion_pages
          WHERE
            lower(coalesce(content, '')) LIKE lower($1) ESCAPE '\\'
            AND ${topicFilterSql}
          ORDER BY notion_edited_at DESC NULLS LAST, title ASC
          LIMIT ${SQL_RESULT_LIMIT}
          `,
          [personTerm, fuzzyPersonTerm, topicTerm],
        );

    if (!rows.length) {
      return `I couldn't find any Notion pages linked to **${person}**${docTitle ? ` for "${docTitle}"` : ""}. Try **"What projects is ${person} assigned to?"** for owner/assignee fields.`;
    }

    const topicNote = docTitle ? ` (filtered by "${docTitle}")` : "";
    const top = rows[0];
    const editedLabel = top.notion_edited_at
      ? new Date(top.notion_edited_at).toLocaleDateString()
      : "date not stored — re-sync to refresh";

    const usedMentionsOnly = primaryRows.length === 0;
    const summary = usedMentionsOnly
      ? `No pages where **${person}** is owner, creator, or last editor${topicNote}. Below: pages that only **mention** the name in body text (weaker signal).`
      : `**Strongest match for ${person}**${topicNote}: **${top.title || "Untitled"}** (${top.activity_role}, last edited in Notion: ${editedLabel}).`;

    return `${summary}\n\n### ${rows.length} page(s)\n\n${formatRows(rows, (row) => {
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
