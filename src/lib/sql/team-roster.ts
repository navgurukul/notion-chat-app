import { escapeLike, query } from "@/lib/db";
import { TEAM_MEMBER_WHITELIST } from "@/lib/db/team-members";
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
  activityScore: number;
  pageCount: number;
  roles: string[];
};

const PERSON_FIELD_NOISE =
  /^(unknown|n\/a|none|navgurukul|notion|unassigned|tbd|me|team|project|-+)$/i;

const MENTION_NOISE =
  /^(untitled|backend|datapivots|navgurkul|design|scope|item|user|admin|qa|dev|pm|billing|rate|total|due|gmail|please)$/i;

function personDedupeKey(name: string) {
  return normalizePersonNameForMatch(name);
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
  if (trimmed.length < 2 || trimmed.length > 40) return false;

  // Whitelist check
  const key = personDedupeKey(trimmed);
  if (TEAM_MEMBER_WHITELIST.has(key)) return true;

  if (PERSON_FIELD_NOISE.test(trimmed) || MENTION_NOISE.test(trimmed)) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/[@#:|{}()[\]"'$%&?*+=\/\\_]/.test(trimmed)) return false;
  if (/[.!?]$/.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();

  // Noise word pattern (teams, roles, conjunctions, technical terms, calendar/process terms)
  const noisePattern = /\b(team|project|members?|staff|users?|admins?|group|bots?|support|headline|task|tasks|vision|mission|roadmap|status|update|daily|weekly|monthly|meeting|call|sync|notes|retro|board|channel|guild|chapter|tribe|squad|lead|manager|pm|qa|dev|engineer|designer|coordinator|intern|fellow|consultant|employee|contractor|would|will|should|could|can|has|have|had|is|are|was|were|why|what|who|which|how|do|does|did|worked|working|assigned|assign|create|created|edit|edited|update|updated|added|add|remove|removed|delete|deleted|done|fixed|fix|page|docs?|documents?|layer|base|param|returns?|memberof|typedef|property|throws|deprecated|example|link|author|since|version|css|js|ts|html|code|snippet|test|spec|mock|stub|config|env|build|scripts?|npm|yarn|pnpm|git|github|gitlab|deploy|prod|staging|local)\b/;
  
  if (noisePattern.test(lower)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false; // Increased from 3 to 4 to allow for longer names

  for (const word of words) {
    if (!/^[A-Za-z][A-Za-z'.-]*$/.test(word)) return false;
  }

  return true;
}

/** Split "Sanjna Panwar, Shailesh Pandey" into individual names. */
export function splitPersonField(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((part) => cleanPersonVariant(normalizePersonNameForMatch(part.trim())))
    .filter((name) => looksLikePersonName(name));
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
  const byKey = new Map<
    string,
    { name: string; score: number; roles: Set<string>; pages: Set<string> }
  >();
  const roleWeights: Record<string, number> = {
    owner: 5,
    assignee: 4,
    "last edited": 3,
    created: 2,
    mentioned: 1,
    captain: 4,
    "owner (in page)": 5,
    PM: 4,
    "team roster": 2,
    "billing roster": 1,
  };

  function addPerson(name: string, role: string, pageId: string) {
    const key = personDedupeKey(name);
    if (!TEAM_MEMBER_WHITELIST.has(key) && !looksLikePersonName(name)) {
      return;
    }

    const entry =
      byKey.get(key) ?? { name, score: 0, roles: new Set<string>(), pages: new Set<string>() };
    entry.name = pickLongerName(entry.name, name);
    entry.score += roleWeights[role] ?? 1;
    entry.roles.add(role);
    entry.pages.add(pageId);
    byKey.set(key, entry);
  }

  for (const page of pages) {
    const pageRoles = new Set<string>();

    const processPerson = (name: string, role: string) => {
      const roleKey = `${personDedupeKey(name)}:${role}`;
      if (!pageRoles.has(roleKey)) {
        addPerson(name, role, page.id);
        pageRoles.add(roleKey);
      }
    };

    for (const name of splitPersonField(page.owner)) {
      processPerson(name, "owner");
    }
    for (const name of splitPersonField(page.last_edited_by)) {
      processPerson(name, "last edited");
    }
    for (const name of splitPersonField(page.created_by)) {
      processPerson(name, "created");
    }
    for (const { name, role } of extractPeopleFromContent(page.content)) {
      processPerson(name, role);
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      name: entry.name,
      activityScore: entry.score,
      pageCount: entry.pages.size,
      roles: [...entry.roles].sort(),
    }))
    .sort((a, b) => b.activityScore - a.activityScore);
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


