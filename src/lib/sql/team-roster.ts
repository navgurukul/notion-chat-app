import { escapeLike, query } from "@/lib/db";
import { normalizePersonNameForMatch } from "@/lib/query/normalize";

type ProjectPageRow = {
  id: string;
  title: string | null;
  url: string | null;
  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  content: string | null;
};

export type ProjectMember = {
  name: string;
  pageCount: number;
  roles: string[];
};

const PERSON_FIELD_NOISE =
  /^(unknown|n\/a|none|navgurukul|notion|unassigned|tbd|me|team|project|-+)$/i;

const MENTION_NOISE =
  /^(untitled|backend|datapivots|navgurukul|design|scope|item|user|admin|qa|dev|pm|billing|rate|total|due|gmail|please)$/i;

function personDedupeKey(name: string) {
  return name.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? name.toLowerCase();
}

function pickLongerName(a: string, b: string) {
  return b.length > a.length ? b : a;
}

function cleanPersonVariant(name: string) {
  return name.replace(/\s+[a-z]$/i, "").trim();
}

function parseNotionMention(raw: string): string | null {
  const cleaned = raw.replace(/[,.;:]+$/g, "").trim();
  const parts = cleaned.split(/\s+/);
  const stop = new Set([
    "to",
    "for",
    "and",
    "the",
    "on",
    "in",
    "at",
    "from",
    "please",
    "untitled",
    "add",
    "check",
    "needs",
  ]);
  const nameParts: string[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (stop.has(lower)) break;
    if (/[@.]|\d/.test(part)) break;
    if (!/^[A-Za-z][A-Za-z'.-]*$/i.test(part)) break;
    nameParts.push(part);
    if (nameParts.length >= 3) break;
  }

  const name = cleanPersonVariant(normalizePersonNameForMatch(nameParts.join(" ")));
  return looksLikePersonName(name) ? name : null;
}

/** Looks like a human name (not a sentence fragment). */
function looksLikePersonName(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 48) return false;
  if (PERSON_FIELD_NOISE.test(trimmed) || MENTION_NOISE.test(trimmed)) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/[@#]|https?:\/\//i.test(trimmed)) return false;
  if (/\b(standup|refinement|kanban|sprint|scope|release|item|billing|rate|total|due)\b/i.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}$/.test(trimmed);
}

/** Split "Sanjna Panwar, Shailesh Pandey" into individual names. */
export function splitPersonField(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((part) => cleanPersonVariant(normalizePersonNameForMatch(part.trim())))
    .filter((name) => name.length >= 2 && !PERSON_FIELD_NOISE.test(name) && !/^\d+$/.test(name));
}

/** Pull assignee / captain / team lines from synced page body text. */
export function extractPeopleFromContent(
  content: string | null | undefined,
): Array<{ name: string; role: string }> {
  if (!content?.trim()) return [];

  const found: Array<{ name: string; role: string }> = [];
  const linePatterns: Array<{ re: RegExp; role: string }> = [
    { re: /\bassignee:\s*([^\n]+)/gi, role: "assignee" },
    { re: /\bcaptain:\s*([^\n]+)/gi, role: "captain" },
    { re: /\bassign:\s*([^\n]+)/gi, role: "assignee" },
    { re: /\bassigned:\s*([^\n]+)/gi, role: "assignee" },
    { re: /\bowner:\s*([^\n]+)/gi, role: "owner (in page)" },
    { re: /\bpm:\s*([^\n]+)/gi, role: "PM" },
    { re: /\bproject manager:\s*([^\n]+)/gi, role: "PM" },
    { re: /\b(?:devs?|team|members?):\s*([^\n]+)/gi, role: "team roster" },
  ];

  for (const { re, role } of linePatterns) {
    for (const match of content.matchAll(re)) {
      for (const name of splitPersonField(match[1])) {
        found.push({ name, role });
      }
    }
  }

  for (const match of content.matchAll(/@([A-Za-z][\w'.-]*(?:\s+[A-Za-z][\w'.-]*){0,3})/g)) {
    const name = parseNotionMention(match[1]);
    if (name) {
      found.push({ name, role: "mentioned" });
    }
  }

  for (const match of content.matchAll(
    /(?:^|\n)\s*(?:Devs?|Designers?|Product Managers?|PM|QA)\b[^\n]*\n((?:[ \t]*\d+\.\s*[^\n]+\n?){1,12})/gi,
  )) {
    for (const line of match[1].matchAll(/^\s*\d+\.\s*([^\n]+)/gim)) {
      const chunk = line[1].trim();
      for (const name of splitPersonField(chunk)) {
        if (looksLikePersonName(name)) {
          found.push({ name, role: "team roster" });
        }
      }
    }
  }

  for (const match of content.matchAll(
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*[-–—]\s*Rs\b/gim,
  )) {
    const name = normalizePersonNameForMatch(match[1].trim());
    if (looksLikePersonName(name)) {
      found.push({ name, role: "billing roster" });
    }
  }

  return found;
}

export function topicSearchTokens(scopeTopic: string): string[] {
  const base = scopeTopic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !["project", "the", "workspace", "ai"].includes(t));

  const tokens = new Set(base);
  const lower = scopeTopic.toLowerCase();
  if (lower.includes("datapivot") || [...tokens].some((t) => t.includes("datapivot"))) {
    tokens.add("datapivot");
    tokens.add("datapivots");
    tokens.add("pivot");
    tokens.add("nagaada");
  }

  return [...tokens];
}

export async function fetchProjectPages(scopeTopic: string): Promise<ProjectPageRow[]> {
  const tokens = topicSearchTokens(scopeTopic);
  if (!tokens.length) return [];

  const tokenPatterns = tokens.map((t) => `%${escapeLike(t)}%`);
  const tokenConds = tokenPatterns
    .map(
      (_, i) => `
        lower(coalesce(title, '')) LIKE lower($${i + 1}) ESCAPE '\\'
        OR lower(coalesce(content, '')) LIKE lower($${i + 1}) ESCAPE '\\'
      `,
    )
    .join("\n        OR ");

  return query<ProjectPageRow>(
    `
    SELECT id, title, url, owner, created_by, last_edited_by, content
    FROM notion_pages
    WHERE (${tokenConds})
    LIMIT 80
    `,
    tokenPatterns,
  );
}

export function aggregatePeopleOnProject(pages: ProjectPageRow[]): ProjectMember[] {
  const byKey = new Map<string, { name: string; pages: Set<string>; roles: Set<string> }>();

  function addPerson(name: string, role: string, pageId: string) {
    const key = personDedupeKey(name);
    const entry = byKey.get(key) ?? { name, pages: new Set<string>(), roles: new Set<string>() };
    entry.name = pickLongerName(entry.name, name);
    entry.pages.add(pageId);
    entry.roles.add(role);
    byKey.set(key, entry);
  }

  for (const page of pages) {
    for (const name of splitPersonField(page.owner)) {
      addPerson(name, "owner", page.id);
    }
    for (const name of splitPersonField(page.last_edited_by)) {
      addPerson(name, "last edited", page.id);
    }
    for (const name of splitPersonField(page.created_by)) {
      addPerson(name, "created", page.id);
    }
    for (const { name, role } of extractPeopleFromContent(page.content)) {
      addPerson(name, role, page.id);
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      name: entry.name,
      pageCount: entry.pages.size,
      roles: [...entry.roles].sort(),
    }))
    .sort((a, b) => b.pageCount - a.pageCount || a.name.localeCompare(b.name));
}

export function extractProjectScopeTopic(raw: string, docTitle: string): string {
  const rosterMatch =
    raw.match(
      /\b(?:who(?:\s+all)?|which\s+people|list\s+(?:all\s+)?(?:people|members|team))\b[\s\S]*?\b(?:working|work(?:ing)?)\s+(?:on\s+)?(?:the\s+)?(?:project\s+)?(.+?)(?:\?|$)/i,
    ) ??
    raw.match(
      /\b(?:most|mostly|least|lowest|bottom)\s+active\s+(?:team\s+member|person|contributor|member)?\s*(?:in|on|for)\s+([^?.!]+?)(?:\?|$)/i,
    );

  const fromQuestion = rosterMatch?.[1]
    ?.replace(/\b(team|workspace|project|projects)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (fromQuestion && fromQuestion.length >= 2 && fromQuestion.length <= 64) {
    return fromQuestion;
  }
  return docTitle;
}
