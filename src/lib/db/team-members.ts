// src/lib/db/team-members.ts
import { query } from "@/lib/db";

export type PersonRecord = {
  name: string;
  normalized: string;
};

let _directory: PersonRecord[] | null = null;
let _lastFetched = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getPeopleDirectory(): Promise<PersonRecord[]> {
  const now = Date.now();
  if (_directory && now - _lastFetched < CACHE_TTL_MS) return _directory;

  const rows = await query<{ name: string }>(`
    SELECT DISTINCT name FROM (
      SELECT trim(unnest(string_to_array(owner, ','))) AS name FROM notion_pages WHERE owner IS NOT NULL
      UNION
      SELECT trim(created_by) FROM notion_pages WHERE created_by IS NOT NULL
      UNION
      SELECT trim(last_edited_by) FROM notion_pages WHERE last_edited_by IS NOT NULL
    ) AS people
    WHERE trim(name) <> '' AND length(trim(name)) >= 2
    ORDER BY name
  `);

  _directory = rows
    .map((r) => r.name.trim())
    .filter(Boolean)
    .map((name) => ({ name, normalized: name.toLowerCase() }));

  _lastFetched = now;
  return _directory;
}

export function invalidatePeopleDirectory() {
  _directory = null;
}

export async function resolvePersonName(
  input: string,
): Promise<{ exact: string | null; candidates: string[] }> {
  const dir = await getPeopleDirectory();
  const q = input.trim().toLowerCase();
  if (!q) return { exact: null, candidates: [] };

  const exact = dir.find((p) => p.normalized === q);
  if (exact) return { exact: exact.name, candidates: [] };

  const firstNameMatches = dir.filter((p) => {
    const firstName = p.normalized.split(/\s+/)[0];
    return firstName === q;
  });
  if (firstNameMatches.length === 1)
    return { exact: firstNameMatches[0].name, candidates: [] };
  if (firstNameMatches.length > 1)
    return { exact: null, candidates: firstNameMatches.map((p) => p.name) };

  const partialMatches = dir.filter((p) => p.normalized.includes(q));
  if (partialMatches.length === 1)
    return { exact: partialMatches[0].name, candidates: [] };
  if (partialMatches.length > 1)
    return { exact: null, candidates: partialMatches.map((p) => p.name) };

  return { exact: null, candidates: [] };
}

// Backward compatibility — team-roster.ts still imports this
export const TEAM_MEMBER_WHITELIST = new Set<string>();