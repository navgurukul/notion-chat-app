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

function escapeLike(value: string) {
  return value.replace(/[%_]/g, "\\$&");
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

function formatListHeader(count: number, label: string) {
  return `### ${count} doc(s) ${label}`;
}

function formatRows(rows: NotionPageRow[], formatter: (row: NotionPageRow) => string) {
  return rows.map((row) => `- ${formatter(row)}`).join("\n");
}

function contentSnippet(content?: string | null, maxLength = 450) {
  const cleaned = (content || "")
    .replace(/=== PROPERTIES ===|=== CONTENT ===/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

async function lookupByTitle(title: string) {
  const term = `%${escapeLike(title)}%`;
  return query<NotionPageRow>(
    `
    SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
    FROM notion_pages
    WHERE
      lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      OR to_tsvector('english', coalesce(title, '')) @@ plainto_tsquery('english', $2)
    ORDER BY
      CASE WHEN lower(coalesce(title, '')) = lower($2) THEN 0 ELSE 1 END,
      ts_rank(to_tsvector('english', coalesce(title, '')), plainto_tsquery('english', $2)) DESC,
      title ASC
    LIMIT 100
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
      LIMIT 500
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
      LIMIT 500
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
      LIMIT 200
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
      LIMIT 700
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
      LIMIT 20
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

  if (parsed.kind === "topic_list" && docTitle) {
    const rows = await query<NotionPageRow>(
      `
      SELECT id, title, url, owner, created_by, last_edited_by, doc_type, status
      FROM notion_pages
      WHERE lower(coalesce(title, '')) LIKE lower($1) ESCAPE '\\'
      ORDER BY title ASC
      LIMIT 700
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
    const rows = await lookupByTitle(docTitle);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const row = rows[0];
      return `**Status of "${row.title || docTitle}":** ${row.status || "Unknown"}${
        row.url ? `\n\n${formatLink("Open in Notion", row.url)}` : ""
      }`;
    }
    return `### ${rows.length} matching docs for "${docTitle}"\n\n${formatRows(
      rows,
      (row) =>
        `**${formatLink(row.title || "Untitled", row.url)}** — Status: **${row.status || "Unknown"}**`,
    )}`;
  }

  return null;
}
