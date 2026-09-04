/**
 * Canonical person-name detection, directory resolution, and shared
 * text/title normalization for the query pipeline.
 *
 * Single source of truth — this file absorbs what used to be three
 * separate files (normalize.ts, year.ts, topic-resolution.ts) plus a
 * stripDocWords()/cleanExtractedTitle() pair that was copy-pasted
 * independently in rules.ts and entity-resolver/document.ts. Those two
 * copies had silently drifted apart (rules.ts's version ran the result
 * through cleanExtractedTitle, document.ts's did not) — merging them
 * here makes that a single, deliberate behavior instead of an accidental
 * divergence. If you need the old cleanExtractedTitle-free behavior for
 * some call site, do it explicitly at the call site, not by re-forking
 * this function again.
 */

export type PersonRecord = {
  name: string;
  normalized: string;
};

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

const NOISE_VOCAB =
  /\b(team|project|members?|staff|users?|admins?|group|bots?|support|headline|task|tasks|vision|mission|roadmap|status|update|daily|weekly|monthly|meeting|call|sync|notes|retro|board|channel|guild|chapter|tribe|squad|lead|manager|pm|qa|dev|engineer|designer|coordinator|intern|fellow|consultant|employee|contractor|would|will|should|could|can|has|have|had|is|are|was|were|why|what|who|which|how|do|does|did|worked|working|assigned|assign|create|created|edit|edited|update|updated|added|add|remove|removed|delete|deleted|done|fixed|fix|page|docs?|documents?|layer|base|param|returns?|memberof|typedef|property|throws|deprecated|example|link|author|since|version|css|js|ts|html|code|snippet|test|spec|mock|stub|config|env|build|scripts?|npm|yarn|pnpm|git|github|gitlab|deploy|prod|staging|local)\b/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePersonNameForMatch(name: string) {
  return name
    .trim()
    .replace(/\s+(?:ji|jee|ji\.|sir|ma'?am|ben|bhai|didi|madam)\s*$/i, "")
    .trim();
}

export function personDedupeKey(name: string) {
  return normalizePersonNameForMatch(name).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * True if `value` plausibly names a real person — not a role, a sentence
 * fragment, a UUID, or workspace vocabulary. `directory` (optional): an
 * exact match against a known person is trusted even if the regex
 * heuristics would otherwise reject it.
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
 * Resolve free-text `input` against the canonical people directory.
 * Order: exact -> unique first-name -> unique substring -> unique
 * typo-tolerant match. Ambiguous matches return all candidates.
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

export function findCanonicalName(input: string, directory: PersonRecord[]): string {
  const { exact } = resolvePersonAgainstDirectory(input, directory);
  return exact ?? input;
}

export function pickLongerName(a: string, b: string) {
  return b.length > a.length ? b : a;
}

// ─── Year extraction ────────────────────────────────────────────────────
// One implementation for both call shapes previously duplicated in
// normalize.ts (extractYearFromQuestion -> undefined) and the standalone
// year.ts (extractYear -> null). Both names still exported so existing
// call sites don't need to change; only one place owns the actual regex now.
function extractYearCore(q: string): number | undefined {
  const match = q.match(/\b(20\d{2})\b/);
  if (match) return parseInt(match[1], 10);
  const lower = q.toLowerCase();
  if (/\bthis\s+year\b/.test(lower)) return new Date().getFullYear();
  if (/\blast\s+year\b/.test(lower)) return new Date().getFullYear() - 1;
  return undefined;
}

export function extractYearFromQuestion(q: string): number | undefined {
  return extractYearCore(q);
}

/** @deprecated Prefer {@link extractYearFromQuestion}. Kept for existing `null`-shaped call sites. */
export function extractYear(query: string): number | null {
  return extractYearCore(query) ?? null;
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

// ─── Doc-title cleanup ──────────────────────────────────────────────────
// Also previously duplicated: rules.ts's copy piped through
// cleanExtractedTitle(), entity-resolver/document.ts's copy did not. The
// unified version below always applies cleanExtractedTitle (rules.ts's
// fuller behavior). If document.ts's resolution quality shifts for titles
// like "... details"/"... spec", that's this change — check the eval set.
const TRAILING_META_WORDS = /\s+(?:details?|info|information|about|spec|specs|specification|requirements?|prd)$/i;

export function cleanExtractedTitle(title: string): string {
  let cleaned = title.trim();
  cleaned = cleaned.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ").trim();

  const canonicalPatterns = [
    /\bemployee\s+information\s+policy$/i,
    /\binformation\s+policy$/i,
    /\bproduct\s+requirements\s+document$/i,
    /\brequirements\s+document$/i,
    /\bprd\s+template$/i,
    /\bapi\s+specification$/i,
    /\bsecurity\s+requirements$/i,
  ];

  const isProtected = canonicalPatterns.some((pattern) => pattern.test(cleaned));

  if (!isProtected) {
    cleaned = cleaned.replace(TRAILING_META_WORDS, "").trim();
  }

  return cleaned;
}

export function stripDocWords(value: string): string {
  const step1 = value
    .replace(
      /\b(page|doc|document|docs|pages|project|projects|task|tasks|work|worked|assigned|assign|assignee|given|got|to|the|a|an|all|every|some|any|only|one|feature|features)\b/gi,
      "",
    )
    .replace(/^(what|which|who|where|when|why|how|was|is)\s+/i, "")
    .replace(/'s\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleanExtractedTitle(step1);
}

// ─── Topic <-> Notion page title matching ──────────────────────────────
// Shared by entity resolution and SQL project scoping — prefer hubs over
// task tickets.
function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function titlesReferToSameTopic(topic: string, title: string) {
  const t = topic.trim().toLowerCase();
  const row = title.trim().toLowerCase();
  if (!t || !row) return false;
  if (row === t) return true;
  if (row.startsWith(`${t} `) || row.startsWith(`${t}-`) || row.startsWith(`${t}—`)) return true;
  if (new RegExp(`\\b${escapeRegex(t)}\\b`, "i").test(title)) return true;
  return false;
}

export function scoreTitleForTopic(topic: string, title: string | null | undefined): number {
  const t = topic.trim().toLowerCase();
  const row = (title ?? "").trim();
  if (!t || !row) return 0;

  const lower = row.toLowerCase();
  if (lower === t) return 10_000;

  const wordRe = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
  const hasWord = wordRe.test(row);
  const hasSubstring = lower.includes(t);
  if (!hasWord && !hasSubstring) return 0;

  let score = 600;
  if (hasWord) score += 500;
  if (hasSubstring && !hasWord && t.length > 12) score += 100;

  if (new RegExp(`^${escapeRegex(t)}(\\s|$|[-—])`, "i").test(row)) score += 250;
  if (new RegExp(`^${escapeRegex(t)}\\s+(app|mvp|prd|modes|platform|project|hub)\\b`, "i").test(row)) {
    score += 180;
  }

  score -= Math.min(row.length, 140);

  if (/^(tc-\d+|bug\b|fix\b|issue\b)/i.test(row)) score -= 400;
  if (/\b(migrate|migration|mismatch|incorrect|doesn't match|does not match|overlap|delayed|cutoff|permission|privacy policy|terms of use|figma)\b/i.test(lower)) {
    score -= 220;
  }
  if (/\[[^\]]+\]/.test(row) || /^"/.test(row)) score -= 120;
  if (/\b(transcription|keyboard|logo text|header section)\b/i.test(lower)) score -= 160;

  return score;
}

export function pickBestTitleMatch<T extends { title: string | null }>(
  topic: string,
  candidates: T[],
): T | null {
  if (!candidates.length) return null;

  const ranked = candidates
    .map((row) => ({ row, score: scoreTitleForTopic(topic, row.title) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.row.title?.length ?? 0) - (b.row.title?.length ?? 0));

  return ranked[0]?.row ?? null;
}

export function shouldKeepOriginalTopic(original: string, resolved: string) {
  const o = original.trim();
  const r = resolved.trim();
  if (!o || !r || o.toLowerCase() === r.toLowerCase()) return false;
  if (o.length > 32) return false;
  if (r.length <= o.length * 2) return false;
  return !titlesReferToSameTopic(o, r);
}