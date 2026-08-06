import { escapeLike } from "@/lib/db";

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
