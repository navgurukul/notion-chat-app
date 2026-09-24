export { ensureSchema, query, getClient, vectorQuery } from "./postgres";
export { escapeLike, likePattern } from "./sql-utils";
export {
  getNotionLastSyncRun,
  setNotionLastSyncRun,
  NOTION_LAST_SYNC_RUN_KEY,
} from "./sync-metadata";

// --- team-members merged here to reduce file count ---
import { query as pgQuery } from "./postgres";
import { levenshtein } from "@/lib/query/normalize";

export type PersonRecord = {
  name: string;
  normalized: string;
};

let _directory: PersonRecord[] | null = null;
let _lastFetched = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

const PERSON_FIELD_NOISE =
  /^(unknown|n\/a|none|navgurukul|notion|unassigned|tbd|me|team|project|-+)$/i;

const MENTION_NOISE =
  /^(untitled|backend|datapivots|navgurkul|design|scope|item|user|admin|qa|dev|pm|billing|rate|total|due|gmail|please|cost|price|rs|invoice|sow|proposal|value|fee|fees|charges|usd|inr|pay|payment)$/i;

const NON_PERSON_PATTERNS = [
  /^PnC$/i,
  /^Billing\s+rate$/i,
  /^Total\s+Due$/i,
  /^aws-amplify$/i,
  /^production[- ]server/i,
  /use\s+this$/i,
  /\bAI$/i,
  /^Untitled/i,
  /^(backend|frontend|fullstack)$/i,
  /^(admin|administrator|coordinator)$/i,
  /^(hr|pnc|finance|accounts)$/i,
  /^(intern|trainee|fellow)$/i,
  /^growth\s+(manager|lead|team)$/i,
  /^(product|program|project)\s+(manager|lead|owner)$/i,
  /^Bot$/i,
  /^Content\s+(writer|creator|manager)$/i,
];

function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return false;

  if (PERSON_FIELD_NOISE.test(trimmed)) return false;
  if (MENTION_NOISE.test(trimmed)) return false;
  for (const pattern of NON_PERSON_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  if (/\d/.test(trimmed)) return false;
  if (/[@#:|{}()[\]"'$%&?*+=\/\\_]/.test(trimmed)) return false;
  if (/[.!?]$/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const verbPattern = /\b(is|are|was|were|has|have|had|use|used|using|this|that|the|and|for|to)\b/i;
  if (words.length >= 3 && verbPattern.test(trimmed)) return false;

  return true;
}

function normalizeNameValue(name: string): string | null {
  const trimmed = name.trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(trimmed)) return null;
  if (!looksLikePersonName(trimmed)) return null;

  let capitalized = trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  const parts = capitalized.split(" ");
  if (parts.length === 2 && parts[0] === parts[1]) {
    capitalized = parts[0];
  }

  return capitalized;
}

export async function getPeopleDirectory(): Promise<PersonRecord[]> {
  const now = Date.now();
  if (_directory && now - _lastFetched < CACHE_TTL_MS) return _directory;

  // FIX (Accuracy): previously this directory only pulled from the owner /
  // created_by / last_edited_by columns. A member who only ever appears as
  // an "Assignee:" or "Captain:" line inside a page's free-text body (never
  // as the page owner/creator/editor) was invisible here — so resolvePersonName
  // could never even attempt a first-name/substring match for them, no
  // matter how correctly their name was typed. The UNION branch below pulls
  // those in-content role lines too. `extractPeopleFromContent` in
  // sql/team-roster.ts does a more thorough version of this same job but
  // isn't reused here on purpose — it imports getPeopleDirectory from this
  // same module, so importing it back here would create a circular import.
  const rows = await pgQuery<{ name: string }>(`
    SELECT DISTINCT name FROM (
      SELECT trim(unnest(string_to_array(owner, ','))) AS name FROM notion_pages WHERE owner IS NOT NULL
      UNION
      SELECT trim(created_by) FROM notion_pages WHERE created_by IS NOT NULL
      UNION
      SELECT trim(last_edited_by) FROM notion_pages WHERE last_edited_by IS NOT NULL
      UNION
      SELECT trim(m[1]) FROM notion_pages,
        LATERAL regexp_matches(
          content,
          '(?:assignee|captain|assign|assigned)\\s*:\\s*([^\\n]+)',
          'gi'
        ) AS m
      WHERE content IS NOT NULL
    ) AS people
    WHERE trim(name) <> '' AND length(trim(name)) >= 2
    ORDER BY name
  `);

  const uniqueNames = new Set<string>();
  const dir: PersonRecord[] = [];

  for (const r of rows) {
    // Content-line matches can carry multiple comma/and-separated names on
    // one line ("Assignee: Ravi, Priya"). Splitting is a no-op for the
    // single-name owner/created_by/last_edited_by rows, so it's safe to
    // always run every row through this rather than branching by source.
    for (const part of r.name.split(/\s*(?:,|;|&|\band\b)\s*/i)) {
      const cleaned = normalizeNameValue(part);
      if (!cleaned) continue;

      const normalized = cleaned.toLowerCase();
      if (!uniqueNames.has(normalized)) {
        uniqueNames.add(normalized);
        dir.push({ name: cleaned, normalized });
      }
    }
  }

  dir.sort((a, b) => a.name.localeCompare(b.name));

  _directory = dir;
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
  let q = input.trim().toLowerCase();
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

  // FIX (Accuracy): previously, if a name didn't exactly/first-name/substring
  // match anyone in the directory, we silently accepted the raw (possibly
  // misspelled) input as if it had resolved — the downstream SQL LIKE query
  // would then search for a name that doesn't exist and come back empty, or
  // (worse) a vowel-stripped fallback elsewhere would coincidentally match
  // the wrong person. A genuine typo ("Tammana", "Rahull") never got
  // corrected because nothing here ever tried. Single-word inputs now get a
  // Levenshtein-distance pass against directory first names before we give
  // up and echo the raw input back. Budget scales with name length so short
  // names ("Om") don't fuzzy-match everything.
  if (!q.includes(" ")) {
    const fuzzy = dir.filter((p) => {
      const firstName = p.normalized.split(/\s+/)[0];
      const budget = firstName.length <= 4 ? 1 : 2;
      return levenshtein(q, firstName) <= budget;
    });
    if (fuzzy.length === 1) return { exact: fuzzy[0].name, candidates: [] };
    if (fuzzy.length > 1)
      return { exact: null, candidates: fuzzy.map((p) => p.name) };
  }

  if (looksLikePersonName(input)) {
    const fallbackName = normalizeNameValue(input) || input.trim();
    return { exact: fallbackName, candidates: [] };
  }

  return { exact: null, candidates: [] };
}

export const TEAM_MEMBER_WHITELIST = new Set<string>();