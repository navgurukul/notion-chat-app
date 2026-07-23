/**
 * Canonical person-name detection and directory resolution.
 *
 * Single source of truth — replaces three previously-diverging implementations
 * that used different noise-word lists and disagreed on edge cases:
 *   - team-roster.ts   :: looksLikePersonName / findCanonicalName
 *   - team-members.ts  :: looksLikePersonName / resolvePersonName
 * A name that passed one filter could silently fail the other downstream,
 * dropping a real person from results with no error anywhere.
 */

export type PersonRecord = {
  name: string;
  normalized: string;
};

/** Words/short phrases that show up in owner/editor/content fields but are never a person's name. */
const NOISE_WORDS = new Set([
  "unknown", "n/a", "none", "navgurukul", "navgurkul", "notion", "unassigned", "tbd",
  "me", "team", "project", "backend", "frontend", "fullstack", "datapivots",
  "design", "scope", "item", "user", "admin", "administrator", "coordinator",
  "qa", "pm", "hr", "pnc", "finance", "accounts", "intern", "trainee", "fellow",
  "bot", "billing", "rate", "total", "due", "gmail", "please", "cost", "price",
  "rs", "invoice", "sow", "proposal", "value", "fee", "fees", "charges", "usd",
  "inr", "pay", "payment", "untitled",
  "to", "for", "and", "the", "on", "in", "at", "from", "add", "check", "needs",
]);

/** Multi-word non-person strings that slip past the single-word list. */
const NON_PERSON_PATTERNS = [
  /^-+$/,
  /^untitled/i,
  /^billing\s+rate$/i,
  /^total\s+due$/i,
  /^aws-amplify$/i,
  /^production[- ]server/i,
  /use\s+this$/i,
  /\bAI$/i,
  /^growth\s+(manager|lead|team)$/i,
  /^(product|program|project)\s+(manager|lead|owner)$/i,
  /^content\s+(writer|creator|manager)$/i,
];

/** Role/process vocabulary that means the string describes work, not a person. */
const NOISE_VOCAB =
  /\b(team|project|members?|staff|users?|admins?|group|bots?|support|headline|task|tasks|vision|mission|roadmap|status|update|daily|weekly|monthly|meeting|call|sync|notes|retro|board|channel|guild|chapter|tribe|squad|lead|manager|pm|qa|dev|engineer|designer|coordinator|intern|fellow|consultant|employee|contractor|would|will|should|could|can|has|have|had|is|are|was|were|why|what|who|which|how|do|does|did|worked|working|assigned|assign|create|created|edit|edited|update|updated|added|add|remove|removed|delete|deleted|done|fixed|fix|page|docs?|documents?|layer|base|param|returns?|memberof|typedef|property|throws|deprecated|example|link|author|since|version|css|js|ts|html|code|snippet|test|spec|mock|stub|config|env|build|scripts?|npm|yarn|pnpm|git|github|gitlab|deploy|prod|staging|local)\b/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip common honorifics for matching ("Amruta ji" -> "Amruta"). */
export function normalizePersonNameForMatch(name: string) {
  return name
    .trim()
    .replace(/\s+(?:ji|jee|ji\.|sir|ma'?am|ben|bhai|didi|madam)\s*$/i, "")
    .trim();
}

/** Stable dedupe/lookup key for a person name. */
export function personDedupeKey(name: string) {
  return normalizePersonNameForMatch(name).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True if `value` plausibly names a real person — not a role, a sentence
 * fragment, a UUID, or workspace vocabulary.
 *
 * `directory` is optional: an exact match against a known person from
 * `getPeopleDirectory()` is trusted even if the regex heuristics below would
 * otherwise reject it (e.g. an unusually short real name). The directory is
 * ground truth; the regex is a best-effort guess for names not seen yet.
 */
export function looksLikePersonName(value: string, directory?: PersonRecord[]): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (directory?.some((p) => p.normalized === personDedupeKey(trimmed))) {
    return true;
  }

  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (UUID_RE.test(trimmed)) return false;
  if (NOISE_WORDS.has(trimmed.toLowerCase())) return false;
  if (NON_PERSON_PATTERNS.some((p) => p.test(trimmed))) return false;
  if (/\d/.test(trimmed)) return false;
  if (/[@#:|{}()[\]"'$%&?*+=\/\\_]/.test(trimmed)) return false;
  if (/[.!?]$/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;

  for (const word of words) {
    if (NOISE_WORDS.has(word.toLowerCase())) return false;
    if (!/^[A-Za-z][A-Za-z'.-]*$/.test(word)) return false;
  }

  // Slug/command-like: "add user to project" (all-lowercase multi-word)
  if (words.length >= 2 && words.every((w) => /^[a-z]/.test(w))) return false;
  if (NOISE_VOCAB.test(trimmed)) return false;

  return true;
}

/** Title-case + dedupe repeated tokens ("Mahendra Mahendra" -> "Mahendra"). Returns null if not a plausible name. */
export function normalizeDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (UUID_RE.test(trimmed)) return null;
  if (!looksLikePersonName(trimmed)) return null;

  let capitalized = trimmed
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  const parts = capitalized.split(" ");
  if (parts.length === 2 && parts[0] === parts[1]) capitalized = parts[0];

  return capitalized;
}

/** Iterative Levenshtein distance — used only for the small fuzzy fallback below. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Resolve free-text `input` (from a question, or a name pulled out of Notion
 * body text) against the canonical people directory.
 *
 * Replaces the two previously-divergent implementations
 * (team-members.ts::resolvePersonName and team-roster.ts::findCanonicalName)
 * with one matching order: exact -> unique first-name -> unique substring ->
 * unique typo-tolerant match. Ambiguous matches return all candidates
 * instead of guessing one.
 */
export function resolvePersonAgainstDirectory(
  input: string,
  directory: PersonRecord[],
): { exact: string | null; candidates: string[] } {
  const q = personDedupeKey(input);
  if (!q) return { exact: null, candidates: [] };

  const exact = directory.find((p) => p.normalized === q);
  if (exact) return { exact: exact.name, candidates: [] };

  const inputFirstName = q.split(" ")[0];
  const firstNameMatches = directory.filter(
    (p) => p.normalized.split(" ")[0] === inputFirstName,
  );
  if (firstNameMatches.length === 1) return { exact: firstNameMatches[0].name, candidates: [] };
  if (firstNameMatches.length > 1) {
    return { exact: null, candidates: firstNameMatches.map((p) => p.name) };
  }

  const partialMatches = directory.filter((p) => p.normalized.includes(q));
  if (partialMatches.length === 1) return { exact: partialMatches[0].name, candidates: [] };
  if (partialMatches.length > 1) {
    return { exact: null, candidates: partialMatches.map((p) => p.name) };
  }

  // Typo-tolerant fallback for single-word queries (replaces the old hardcoded
  // "sanjana" -> "sanjna" special case with a general rule: small edit-distance
  // budget scaled to name length, so it won't collide two different short names).
  if (!q.includes(" ")) {
    const fuzzy = directory.filter((p) => {
      const firstName = p.normalized.split(" ")[0];
      const budget = firstName.length <= 4 ? 1 : 2;
      return levenshtein(q, firstName) <= budget;
    });
    if (fuzzy.length === 1) return { exact: fuzzy[0].name, candidates: [] };
    if (fuzzy.length > 1) return { exact: null, candidates: fuzzy.map((p) => p.name) };
  }

  return { exact: null, candidates: [] };
}

/** Convenience wrapper for old `findCanonicalName` call sites — returns input unchanged if nothing resolves. */
export function findCanonicalName(input: string, directory: PersonRecord[]): string {
  const { exact } = resolvePersonAgainstDirectory(input, directory);
  return exact ?? input;
}

export function pickLongerName(a: string, b: string) {
  return b.length > a.length ? b : a;
}

export function extractYearFromQuestion(q: string): number | undefined {
  const match = q.match(/\b(20\d{2})\b/);
  if (match) return parseInt(match[1], 10);
  if (/\bthis\s+year\b/i.test(q)) return new Date().getFullYear();
  if (/\blast\s+year\b/i.test(q)) return new Date().getFullYear() - 1;
  return undefined;
}

export function isCrossDocSummaryQuestion(q: string): boolean {
  return /\b(across|all|summarize|themes|main themes|overview across)\b/i.test(q);
}

export function extractCrossDocSummaryTopic(q: string): string | undefined {
  const match = q.match(/\b(?:across|in|of|about)\s+(?:all\s+)?(.+?)(?:\s+docs|\s+pages|\s+projects|\?|$)/i);
  return match?.[1]?.trim();
}

export function looksLikeSinglePageTitle(title: string): boolean {
  if (!title.trim()) return false;
  return title.trim().split(/\s+/).length <= 8;
}

export function stripYearSuffixFromPerson(name: string): string {
  return name.replace(/\s+(?:in|for|year)?\s*20\d{2}$/i, "").trim();
}

export function isNoiseTopic(topic: string): boolean {
  const norm = topic.trim().toLowerCase();
  return ["all", "everything", "stuff", "pages", "docs", "documents"].includes(norm);
}

export function isWorkspaceScope(title: string): boolean {
  const norm = title.trim().toLowerCase();
  return ["workspace", "all", "navgurukul", "navgurkul", "entire", "global"].includes(norm);
}