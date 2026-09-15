import { escapeLike, query } from "@/lib/db";
import type { ActivityRow } from "@/lib/shared/notion-types";

type PersonActivityQuery = {
  personTerm: string;
  fuzzyPersonTerm: string;
  topicTerm: string | null;
  requireYear: boolean;
  yearStart: string | null;
  yearEnd: string | null;
  rowLimit: number;
};

export async function findPersonActivityRows({
  personTerm,
  fuzzyPersonTerm,
  topicTerm,
  requireYear,
  yearStart,
  yearEnd,
  rowLimit,
}: PersonActivityQuery) {
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
    ORDER BY role_rank ASC, status_rank ASC, notion_edited_at DESC NULLS LAST, title ASC
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

export function calculateActivityScore(row: ActivityRow, person: string) {
  let score = 0;

  if (row.owner?.includes(person)) score += 5;
  if (row.created_by?.includes(person)) score += 2;
  if (row.last_edited_by?.includes(person)) score += 10;

  return score;
}

// --- Person-matching SQL helpers (merged from person-filter.ts) ---

export function buildPersonMatchParams(person: string) {
  const personTerm = `%${escapeLike(person)}%`;
  const personName = person.trim().toLowerCase();
  return { personTerm, personName };
}

export function personColumnMatchSql(column: string, paramIndex1: number, paramIndex2?: number) {
  if (paramIndex2) {
    return `(lower(coalesce(${column}, '')) LIKE lower($${paramIndex1}) ESCAPE '\\' OR ($${paramIndex2}::text IS NOT NULL AND lower(coalesce(${column}, '')) LIKE ('%' || lower($${paramIndex2}::text) || '%') ESCAPE '\\'))`;
  }
  return `lower(coalesce(${column}, '')) LIKE lower($${paramIndex1}) ESCAPE '\\'`;
}

export function personColumnsMatchSql(columns: string[], paramIndex1: number, paramIndex2?: number) {
  return `(${columns.map(col => personColumnMatchSql(col, paramIndex1, paramIndex2)).join(" OR ")})`;
}