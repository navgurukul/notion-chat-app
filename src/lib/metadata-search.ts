/**
 * Metadata Search — Layer 2
 *
 * Direct SQL queries against notion_pages table.
 * Returns accurate, structured answers for property-based queries.
 * No AI involved — no hallucination possible.
 */

import { query } from "./postgres";
import type { ParsedQuery } from "./query-router";

type NotionPageRow = {
  id: string;
  title: string | null;
  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  type: string | null;
  status: string | null;
  stage: string | null;
  url: string | null;
  created_on: string | null;
  last_edited: string | null;
};

const NOT_FOUND = "I couldn't find this in the available Notion data. The information may exist in Notion but wasn't retrieved.";

function formatPageList(pages: NotionPageRow[], labelField: keyof NotionPageRow): string {
  if (pages.length === 0) return NOT_FOUND;
  return pages
    .map((p) => {
      const label = p[labelField] ?? "Unknown";
      const url = p.url ? `\n  [Open in Notion](${p.url})` : "";
      return `- **${p.title ?? "Untitled"}** — ${labelField.replace(/_/g, " ")}: ${label}${url}`;
    })
    .join("\n");
}

export async function handleMetadataQuery(parsed: ParsedQuery): Promise<string | null> {
  const { kind, personName, docTitle } = parsed;

  switch (kind) {
    case "owner_list": {
      if (!personName) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, owner, url FROM notion_pages
         WHERE lower(owner) LIKE lower($1)
         ORDER BY title`,
        [`%${personName}%`],
      );
      if (rows.length === 0) return NOT_FOUND;
      return `### ${rows.length} doc(s) owned by ${personName}\n\n` + formatPageList(rows, "owner");
    }

    case "created_by_list": {
      if (!personName) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, created_by, url FROM notion_pages
         WHERE lower(created_by) LIKE lower($1)
         ORDER BY title`,
        [`%${personName}%`],
      );
      if (rows.length === 0) return NOT_FOUND;
      return `### ${rows.length} doc(s) created by ${personName}\n\n` + formatPageList(rows, "created_by");
    }

    case "owner_of": {
      if (!docTitle) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, owner, url FROM notion_pages
         WHERE lower(title) LIKE lower($1)
         ORDER BY
           CASE WHEN lower(title) = lower($2) THEN 0 ELSE 1 END, title`,
        [`%${docTitle}%`, docTitle],
      );
      if (rows.length === 0) return NOT_FOUND;
      if (rows.length === 1) {
        const p = rows[0];
        if (!p.owner) return `**"${p.title}"** does not have an Owner property set.`;
        return `**Owner of "${p.title}":** ${p.owner}${p.url ? `\n\n[Open in Notion](${p.url})` : ""}`;
      }
      // Multiple matches — show all
      const lines = rows.map((p) => {
        const ownerStr = p.owner ? `Owner: **${p.owner}**` : "No owner set";
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}** — ${ownerStr}${url}`;
      });
      return `### ${rows.length} matching docs for "${docTitle}"\n\n` + lines.join("\n");
    }

    case "created_by_of": {
      if (!docTitle) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, created_by, url FROM notion_pages
         WHERE lower(title) LIKE lower($1)
         ORDER BY
           CASE WHEN lower(title) = lower($2) THEN 0 ELSE 1 END, title`,
        [`%${docTitle}%`, docTitle],
      );
      if (rows.length === 0) return NOT_FOUND;
      if (rows.length === 1) {
        const p = rows[0];
        if (!p.created_by) return `**"${p.title}"** does not have a Created by field set.`;
        return `**"${p.title}"** was created by: **${p.created_by}**${p.url ? `\n\n[Open in Notion](${p.url})` : ""}`;
      }
      const lines = rows.map((p) => {
        const creatorStr = p.created_by ? `Created by: **${p.created_by}**` : "No creator set";
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}** — ${creatorStr}${url}`;
      });
      return `### ${rows.length} matching docs for "${docTitle}"\n\n` + lines.join("\n");
    }

    case "type_of": {
      if (!docTitle) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, type, url FROM notion_pages
         WHERE lower(title) LIKE lower($1)
         ORDER BY
           CASE WHEN lower(title) = lower($2) THEN 0 ELSE 1 END, title`,
        [`%${docTitle}%`, docTitle],
      );
      if (rows.length === 0) return NOT_FOUND;
      if (rows.length === 1) {
        const p = rows[0];
        if (!p.type) return `**"${p.title}"** does not have a Type property set.`;
        return `**Type of "${p.title}":** ${p.type}${p.url ? `\n\n[Open in Notion](${p.url})` : ""}`;
      }
      const lines = rows.map((p) => {
        const typeStr = p.type ? `Type: **${p.type}**` : "No type set";
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}** — ${typeStr}${url}`;
      });
      return `### ${rows.length} matching docs for "${docTitle}"\n\n` + lines.join("\n");
    }

    case "worked_on_list": {
      if (!personName) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, created_by, last_edited_by, url FROM notion_pages
         WHERE lower(created_by) LIKE lower($1)
            OR lower(last_edited_by) LIKE lower($1)
         ORDER BY title`,
        [`%${personName}%`],
      );
      if (rows.length === 0) return NOT_FOUND;
      const lines = rows.map((p) => {
        const role = p.created_by?.toLowerCase().includes(personName.toLowerCase())
          ? `created by`
          : `last edited by`;
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}** *(${role} ${personName})*${url}`;
      });
      return `### ${rows.length} doc(s) associated with ${personName}\n\n` + lines.join("\n");
    }

    case "status_of": {
      if (!docTitle) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, status, stage, url FROM notion_pages
         WHERE lower(title) LIKE lower($1)
         ORDER BY
           CASE WHEN lower(title) = lower($2) THEN 0 ELSE 1 END, title`,
        [`%${docTitle}%`, docTitle],
      );
      if (rows.length === 0) return NOT_FOUND;
      if (rows.length === 1) {
        const p = rows[0];
        const statusValue = p.status || p.stage;
        if (!statusValue) return `**"${p.title}"** does not have a Status property set.`;
        return `**Status of "${p.title}":** ${statusValue}${p.url ? `\n\n[Open in Notion](${p.url})` : ""}`;
      }
      const lines = rows.map((p) => {
        const statusValue = p.status || p.stage;
        const statusStr = statusValue ? `Status: **${statusValue}**` : "No status set";
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}** — ${statusStr}${url}`;
      });
      return `### ${rows.length} matching docs for "${docTitle}"\n\n` + lines.join("\n");
    }

    case "topic_list": {
      if (!docTitle) return null;
      const rows = await query<NotionPageRow>(
        `SELECT id, title, status, owner, created_by, url FROM notion_pages
         WHERE lower(title) LIKE lower($1)
         ORDER BY title`,
        [`%${docTitle}%`],
      );
      if (rows.length === 0) return NOT_FOUND;
      const lines = rows.map((p) => {
        const meta: string[] = [];
        if (p.status) meta.push(`Status: ${p.status}`);
        if (p.owner) meta.push(`Owner: ${p.owner}`);
        if (p.created_by) meta.push(`Created by: ${p.created_by}`);
        const metaStr = meta.length ? ` *(${meta.join(" · ")})*` : "";
        const url = p.url ? ` — [Open](${p.url})` : "";
        return `- **${p.title ?? "Untitled"}**${metaStr}${url}`;
      });
      return `### ${rows.length} docs matching "${docTitle}"\n\n` + lines.join("\n");
    }

    default:
      return null;
  }
}
