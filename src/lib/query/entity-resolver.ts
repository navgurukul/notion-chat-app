import { query, resolvePersonName as dbResolvePersonName, getPeopleDirectory } from "@/lib/db";
import { getJsonCompletion, ChatHistoryItem } from "@/lib/ai/openai";
import { isNoiseTopic, stripDocWords } from "@/lib/query/normalize";
import type { ParsedQuery } from "@/lib/query/types";

// ─── Resolution Quality & Types ──────────────────────────────────────────

export enum ResolutionQuality {
  EXACT = "EXACT",
  FIRST_NAME = "FIRST_NAME",
  PARTIAL = "PARTIAL",
  NONE = "NONE"
}

export type ResolvedPerson = {
  value: string | null;
  quality: ResolutionQuality;
  confidence: number;
  ambiguous: boolean;
  candidates: string[];
  timedOut?: boolean;
};

export type ResolvedDocument = {
  value: string | null;
  url: string | null;
  quality: ResolutionQuality;
  timedOut?: boolean;
};

export type ResolvedEntity<T> = {
  value: T;
  quality: ResolutionQuality;
};

export type ResolvedEntities = {
  person?: ResolvedEntity<string> & { ambiguous: boolean; candidates: string[]; confidence: number };
  page?: ResolvedEntity<string> & { url: string | null };
  comparePageB?: ResolvedEntity<string> & { url: string | null };
  year?: ResolvedEntity<number>;
  dateRange?: ResolvedEntity<{ dateStart: string | null; dateEnd: string | null }>;
};

// ─── Document Resolution ──────────────────────────────────────────────────

type DocCacheEntry = {
  value: ResolvedDocument;
  expiry: number;
};

const docCache = new Map<string, DocCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;

export function clearEntityCaches() {
  docCache.clear();
  inMemoryGenderCache.clear();
}

function getCacheKey(topic: string): string {
  return topic.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanDocCache() {
  const now = Date.now();
  for (const [key, entry] of docCache.entries()) {
    if (now > entry.expiry) {
      docCache.delete(key);
    }
  }
}

const VERB_STOP_WORDS = new Set([
  "be", "is", "are", "was", "were", "been", "being",
  "complete", "completed", "completing", "completion",
  "do", "does", "did", "doing", "done",
  "go", "going", "gone",
  "work", "worked", "working",
  "create", "created", "creating",
  "assign", "assigned", "assigning",
  "start", "started", "starting",
  "finish", "finished", "finishing",
  "end", "ended", "ending",
  "happen", "happened", "happening",
  "take", "taken", "taking",
  "make", "made", "making",
  "get", "got", "getting",
]);

function isVerbOrActionWord(term: string): boolean {
  const norm = term.toLowerCase().trim();
  if (VERB_STOP_WORDS.has(norm)) return true;
  const words = norm.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => VERB_STOP_WORDS.has(w));
}

function computeMatchScore(topic: string, title: string): { score: number; quality: ResolutionQuality } {
  const tLow = topic.toLowerCase().trim();
  const titleLow = title.toLowerCase().trim();

  if (tLow === titleLow) {
    return { score: 1.00, quality: ResolutionQuality.EXACT };
  }

  const tNorm = tLow.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ");
  const titleNorm = titleLow.replace(/[?!.,;]+/g, "").replace(/\s+/g, " ");
  if (tNorm === titleNorm) {
    return { score: 0.97, quality: ResolutionQuality.EXACT };
  }

  if (titleNorm.startsWith(tNorm)) {
    if (tNorm.length < 3 || isVerbOrActionWord(tNorm)) {
      return { score: 0.0, quality: ResolutionQuality.NONE };
    }
    return { score: 0.94, quality: ResolutionQuality.PARTIAL };
  }

  const escaped = tNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRegex = new RegExp(`\\b${escaped}\\b`, "i");
  if (wordRegex.test(titleNorm)) {
    if (tNorm.length < 4 || isVerbOrActionWord(tNorm)) {
      return { score: 0.0, quality: ResolutionQuality.NONE };
    }
    return { score: 0.85, quality: ResolutionQuality.PARTIAL };
  }

  const tTokens = new Set(tNorm.split(/\s+/).filter(tok => tok.length > 2 && !VERB_STOP_WORDS.has(tok)));
  const titleTokens = new Set(titleNorm.split(/\s+/).filter(tok => tok.length > 2));
  if (tTokens.size > 0 && titleTokens.size > 0) {
    let intersection = 0;
    for (const tok of tTokens) {
      if (titleTokens.has(tok)) intersection++;
    }
    const overlap = intersection / Math.max(tTokens.size, titleTokens.size);
    if (overlap >= 0.5) {
      return { score: 0.85 * overlap, quality: ResolutionQuality.PARTIAL };
    }
  }

  return { score: 0.0, quality: ResolutionQuality.NONE };
}

export async function resolveDocument(topic: string): Promise<ResolvedDocument> {
  const trimmed = topic.trim();
  if (trimmed.length < 3 || isNoiseTopic(trimmed) || isVerbOrActionWord(trimmed)) {
    return { value: null, url: null, quality: ResolutionQuality.NONE };
  }

  const cacheKey = getCacheKey(trimmed);
  cleanDocCache();
  const cached = docCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  const stripped = stripDocWords(trimmed);
  const searchTerms = Array.from(new Set([trimmed, stripped].filter((w) => w && w.length >= 3 && !isVerbOrActionWord(w))));
  if (!searchTerms.length) {
    return { value: null, url: null, quality: ResolutionQuality.NONE };
  }
  const likePatterns = searchTerms.map((term) => `%${term.replace(/[%_\\]/g, "\\$&")}%`);

  let pages = await query<{ title: string | null; url: string | null }>(
    `SELECT title, url FROM notion_pages
     WHERE title IS NOT NULL AND trim(title) <> ''
       AND (${likePatterns.map((_, i) => `title ILIKE $${i + 1}`).join(" OR ")})
     LIMIT 100`,
    likePatterns,
  );

  if (pages.length === 0) {
    try {
      pages = await query<{ title: string | null; url: string | null }>(
        `SELECT title, url FROM notion_pages
         WHERE title IS NOT NULL AND trim(title) <> ''
           AND similarity(title, $1) > 0.15
         ORDER BY similarity(title, $1) DESC
         LIMIT 30`,
        [trimmed],
      );
    } catch {
      // Fallback if pg_trgm extension is not installed
      pages = [];
    }
  }

  let bestMatch: { title: string; url: string | null; score: number; quality: ResolutionQuality } | null = null;

  const matchAgainst = (searchTopic: string) => {
    for (const page of pages) {
      if (!page.title) continue;
      const { score, quality } = computeMatchScore(searchTopic, page.title);
      if (score >= 0.85 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { title: page.title, url: page.url, score, quality };
      }
    }
  };

  matchAgainst(trimmed);

  if (!bestMatch) {
    const stripped = stripDocWords(trimmed);
    if (stripped !== trimmed && stripped.length >= 2) {
      matchAgainst(stripped);
    }
  }

  const result: ResolvedDocument = bestMatch
    ? { value: (bestMatch as any).title, url: (bestMatch as any).url, quality: (bestMatch as any).quality }
    : { value: null, url: null, quality: ResolutionQuality.NONE };

  if (docCache.size >= MAX_CACHE_SIZE) {
    const firstKey = docCache.keys().next().value;
    if (firstKey !== undefined) docCache.delete(firstKey);
  }
  docCache.set(cacheKey, { value: result, expiry: Date.now() + CACHE_TTL_MS });

  return result;
}

// ─── Person Resolution & Gender Lookup ────────────────────────────────────

export async function resolvePerson(input: string): Promise<ResolvedPerson> {
  const name = input.trim();
  if (!name || name.length < 2) {
    return { value: null, quality: ResolutionQuality.NONE, confidence: 0.0, ambiguous: false, candidates: [] };
  }

  await getPeopleDirectory();
  const res = await dbResolvePersonName(name);

  if (res.exact) {
    const dir = await getPeopleDirectory();
    const normalizedInput = name.toLowerCase();

    const exactMatch = dir.find((p) => p.normalized === normalizedInput);
    if (exactMatch) {
      return {
        value: res.exact,
        quality: ResolutionQuality.EXACT,
        confidence: 1.0,
        ambiguous: false,
        candidates: []
      };
    }

    const firstNameMatches = dir.filter((p) => {
      const firstName = p.normalized.split(/\s+/)[0];
      return firstName === normalizedInput;
    });
    if (firstNameMatches.length === 1 && firstNameMatches[0].name === res.exact) {
      return {
        value: res.exact,
        quality: ResolutionQuality.FIRST_NAME,
        confidence: 0.9,
        ambiguous: false,
        candidates: []
      };
    }

    return {
      value: res.exact,
      quality: ResolutionQuality.PARTIAL,
      confidence: 0.5,
      ambiguous: false,
      candidates: []
    };
  }

  if (res.candidates.length > 0) {
    return {
      value: null,
      quality: ResolutionQuality.PARTIAL,
      confidence: 0.5,
      ambiguous: true,
      candidates: res.candidates
    };
  }

  return {
    value: null,
    quality: ResolutionQuality.NONE,
    confidence: 0.0,
    ambiguous: false,
    candidates: []
  };
}

const inMemoryGenderCache = new Map<string, "male" | "female" | "unknown">();

export async function getGenderOfPerson(name: string): Promise<"male" | "female" | "unknown"> {
  const firstName = name.trim().toLowerCase().split(/\s+/)[0];
  if (!firstName) return "unknown";

  if (inMemoryGenderCache.has(firstName)) {
    return inMemoryGenderCache.get(firstName)!;
  }

  const FEMALE_NAMES = new Set([
    "alima", "amruta", "apeksha", "archana", "ashwini", "chhaya", "dhanshri", "goldy",
    "gunavathi", "ira", "komal", "neelam", "neha", "nikita", "pooja", "poonam", "prachi",
    "pranjal", "pranjali", "priya", "priyanka", "saloni", "sanjna", "sanjana", "sapna", "sheetal",
    "sugatha", "sukanya", "tamanna", "ujala", "urmila", "vishakha"
  ]);
  const MALE_NAMES = new Set([
    "aadarsh", "abhishek", "aniket", "anirudh", "arunesh", "gaurav", "mahendra", "mayur",
    "nasir", "mukul", "narendra", "nilesh", "numan", "parichay", "piyush", "prabhat", "priyomjeet",
    "puran", "rohit", "saksham", "santosh", "saquib", "shailesh", "souvik", "suraj", "vinit"
  ]);

  if (FEMALE_NAMES.has(firstName)) {
    inMemoryGenderCache.set(firstName, "female");
    return "female";
  }
  if (MALE_NAMES.has(firstName)) {
    inMemoryGenderCache.set(firstName, "male");
    return "male";
  }

  try {
    const dbResult = await query<{ gender: string }>(
      "SELECT gender FROM name_genders WHERE name = $1 LIMIT 1",
      [firstName]
    );
    if (dbResult.length > 0) {
      const g = dbResult[0].gender === "female" ? "female" : "male";
      inMemoryGenderCache.set(firstName, g);
      return g;
    }
  } catch (error) {
    console.error("[postgres] failed to lookup name_genders:", error);
  }

  try {
    const systemPrompt = `Identify the typical gender of the given first name (often Indian or International). Return JSON: { "gender": "male" | "female" | "unknown" }`;
    const userPrompt = `Name: ${firstName}`;
    const raw = await getJsonCompletion(systemPrompt, userPrompt);
    const jsonText = raw.trim().match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonText) as { gender?: string };
    const lower = parsed.gender?.toLowerCase();
    const detected: "male" | "female" | "unknown" =
      lower === "female" ? "female" : lower === "male" ? "male" : "unknown";

    if (detected !== "unknown") inMemoryGenderCache.set(firstName, detected);
    return detected;
  } catch (error) {
    console.error("[LLM] gender lookup failed for name:", firstName, error);
    return "unknown";
  }
}

// ─── Timeouts & Helpers ───────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[EntityResolver] Timeout after ${timeoutMs}ms, using fallback.`);
      resolve(fallback);
    }, timeoutMs);
    promise.then((res) => {
      clearTimeout(timer);
      resolve(res);
    }).catch(() => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

const ENTITY_RESOLVE_TIMEOUT_MS = 300;

const EMPTY_RESOLVED_PERSON: ResolvedPerson = {
  value: "",
  quality: ResolutionQuality.NONE,
  confidence: 0,
  ambiguous: false,
  candidates: [],
  timedOut: true,
} as ResolvedPerson;

const EMPTY_RESOLVED_DOCUMENT: ResolvedDocument = {
  value: "",
  url: null,
  quality: ResolutionQuality.NONE,
  timedOut: true,
} as ResolvedDocument;

function resolvePersonSafe(name: string): Promise<ResolvedPerson> {
  return withTimeout(resolvePerson(name), ENTITY_RESOLVE_TIMEOUT_MS, EMPTY_RESOLVED_PERSON);
}

function resolveDocumentSafe(title: string): Promise<ResolvedDocument> {
  return withTimeout(resolveDocument(title), ENTITY_RESOLVE_TIMEOUT_MS, EMPTY_RESOLVED_DOCUMENT);
}

// ─── Date & Pronoun Resolution ────────────────────────────────────────────

export function resolveDates(message: string): { year?: number; dateRange?: { dateStart: string | null; dateEnd: string | null } } {
  const q = message.toLowerCase();
  const now = new Date();

  let dateStart: string | null = null;
  let dateEnd: string | null = null;
  let year: number | undefined;

  const months = "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec";
  const MONTH_MAP: Record<string, number> = {
    january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
    june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
    october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
  };

  const pattern1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${months})\\s+(20\\d{2})\\b`, "i");
  const match1 = q.match(pattern1);
  if (match1) {
    const day = parseInt(match1[1], 10);
    const month = MONTH_MAP[match1[2]];
    const yearVal = parseInt(match1[3], 10);
    const start = new Date(Date.UTC(yearVal, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(yearVal, month, day + 1, 0, 0, 0, 0));
    return { year: yearVal, dateRange: { dateStart: start.toISOString(), dateEnd: end.toISOString() } };
  }

  const pattern2 = new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(20\\d{2})\\b`, "i");
  const match2 = q.match(pattern2);
  if (match2) {
    const month = MONTH_MAP[match2[1]];
    const day = parseInt(match2[2], 10);
    const yearVal = parseInt(match2[3], 10);
    const start = new Date(Date.UTC(yearVal, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(yearVal, month, day + 1, 0, 0, 0, 0));
    return { year: yearVal, dateRange: { dateStart: start.toISOString(), dateEnd: end.toISOString() } };
  }

  const pattern3 = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/;
  const match3 = q.match(pattern3);
  if (match3) {
    const yearVal = parseInt(match3[1], 10);
    const month = parseInt(match3[2], 10) - 1;
    const day = parseInt(match3[3], 10);
    const start = new Date(Date.UTC(yearVal, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(yearVal, month, day + 1, 0, 0, 0, 0));
    return { year: yearVal, dateRange: { dateStart: start.toISOString(), dateEnd: end.toISOString() } };
  }

  const pattern4 = /\b(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(20\d{2})\b/;
  const match4 = q.match(pattern4);
  if (match4) {
    const num1 = parseInt(match4[1], 10);
    const num2 = parseInt(match4[2], 10);
    const yearVal = parseInt(match4[3], 10);

    let day: number;
    let month: number;

    if (num1 > 12) {
      day = num1;
      month = num2 - 1;
    } else if (num2 > 12) {
      day = num2;
      month = num1 - 1;
    } else {
      day = num1;
      month = num2 - 1;
    }

    const start = new Date(Date.UTC(yearVal, month, day, 0, 0, 0, 0));
    const end = new Date(Date.UTC(yearVal, month, day + 1, 0, 0, 0, 0));
    return { year: yearVal, dateRange: { dateStart: start.toISOString(), dateEnd: end.toISOString() } };
  }

  if (/\btoday\b/i.test(q) || /\bdaily\b/i.test(q)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\byesterday\b/i.test(q)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\bthis\s+week\b/i.test(q) || /\bweekly\b/i.test(q)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\blast\s+week\b/i.test(q)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1) - 7;
    start.setDate(diff);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\bthis\s+month\b/i.test(q) || /\bmonthly\b/i.test(q)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\blast\s+month\b/i.test(q)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\bthis\s+year\b/i.test(q)) {
    const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  } else if (/\blast\s+year\b/i.test(q)) {
    const start = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    dateStart = start.toISOString();
    dateEnd = end.toISOString();
  }

  const explicitYearMatch = q.match(/\b(20\d{2})\b/);
  if (explicitYearMatch) {
    year = Number(explicitYearMatch[1]);
    if (!dateStart) {
      const start = new Date(year, 0, 1, 0, 0, 0, 0);
      const end = new Date(year + 1, 0, 1, 0, 0, 0, 0);
      dateStart = start.toISOString();
      dateEnd = end.toISOString();
    }
  }

  if (dateStart || year) {
    return {
      year,
      dateRange: dateStart ? { dateStart, dateEnd } : undefined
    };
  }
  return {};
}

export function resolvePronouns(
  message: string,
  sessionName?: string,
  lastPerson?: string
): { message: string; resolvedPerson?: string; resolvedQuality: ResolutionQuality } {
  let text = message;
  let resolvedPerson: string | undefined;
  let resolvedQuality = ResolutionQuality.NONE;

  const firstPersonRegex = /\b(my|me|myself|i)\b/i;
  if (sessionName && firstPersonRegex.test(text)) {
    resolvedPerson = sessionName;
    resolvedQuality = ResolutionQuality.EXACT;
    text = text.replace(/\b(my|me|myself|i)\b/gi, sessionName);
  }

  const thirdPersonRegex = /\b(he|him|his|she|her|hers|they|them|their)\b/i;
  if (lastPerson && thirdPersonRegex.test(text)) {
    resolvedPerson = lastPerson;
    resolvedQuality = ResolutionQuality.EXACT;
    text = text.replace(/\b(he|him|his|she|her|hers|they|them|their)\b/gi, lastPerson);
  }

  return { message: text, resolvedPerson, resolvedQuality };
}

export async function extractRawEntities(message: string): Promise<{ personName?: string; docTitle?: string; compareTitleB?: string }> {
  let personName: string | undefined;
  let docTitle: string | undefined;
  let compareTitleB: string | undefined;

  const dir = await getPeopleDirectory();
  const sortedDir = [...dir].sort((a, b) => b.normalized.length - a.normalized.length);

  const lowerMessage = message.toLowerCase();
  for (const person of sortedDir) {
    const escaped = person.normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(lowerMessage)) {
      personName = person.name;
      break;
    }
  }

  if (!personName) {
    const patterns = [
      /\b(?:assigned\s+to|tasks\s+of|by|for)\s+([a-zA-Z][a-zA-Z'.-]*(?:\s+[a-zA-Z][a-zA-Z'.-]*){0,2})\b/i,
      /\b([a-zA-Z][a-zA-Z'.-]*)\s*'s\s+tasks?\b/i,
      /\b([a-zA-Z][a-zA-Z'.-]*)\s+tasks?\b/i,
    ];
    for (const pat of patterns) {
      const match = message.match(pat);
      if (match?.[1]) {
        const candidate = match[1].trim();
        if (!isNoiseTopic(candidate) && !/^(the|a|an|my|your|his|her|their|our|its|this|that|these|those|all|any|some|few|many|each|every|no|get|list|show|display|find|who|what|where|when|why|how|which|whose|task|tasks|project|projects|person|name|pending|urgent|open|new|recent|old|current|upcoming|overdue)$/i.test(candidate)) {
          personName = candidate;
          break;
        }
      }
    }
  }

  const docMatch = message.match(
    /\b(?:about|status\s+of|details\s+of|project|notes?\s+on|page\s+on)\s+([a-zA-Z][a-zA-Z0-9]+(?:\s+[a-zA-Z0-9]+)?)\b/i,
  );
  if (docMatch?.[1]) {
    const candidateDoc = docMatch[1].trim();
    if (
      !/^\d{4}$/.test(candidateDoc) &&
      !isNoiseTopic(candidateDoc) &&
      !isVerbOrActionWord(candidateDoc) &&
      candidateDoc.length >= 3
    ) {
      docTitle = candidateDoc;
    }
  }

  return { personName, docTitle, compareTitleB };
}

export function isFollowUpNeedingContext(message: string, history: ChatHistoryItem[]): boolean {
  const lower = message.trim().toLowerCase();

  if (/\b(he|him|his|she|her|hers|they|them|their|it|its|this|that|me|my|i)\b/i.test(lower)) {
    return true;
  }

  if (!history || history.length === 0) return false;

  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 10) {
    const followUpPrefixes = [/^(what\s+about|how\s+about|and|but|or|also|then|so)\s+/i];
    for (const pat of followUpPrefixes) {
      if (pat.test(lower)) {
        const remainder = lower.replace(pat, "").replace(/[?.!]/g, "").trim();
        const isGenericAttribute = /^(more|more\s+info|more\s+details|details|status|progress|eta|owner|lead|pm|manager|risks|blockers|tasks?)$/i.test(remainder);
        if (!remainder || isGenericAttribute) {
          return true;
        }
        return false;
      }
    }

    const pureFollowUpPhrases = [
      /^(tell\s+me\s+more|show\s+details|more\s+details|more\s+info|who\s+is\s+the\s+owner|who's\s+the\s+owner|who\s+leads|what's\s+the\s+status|how\s+is\s+it\s+going)\b/i
    ];
    const cleanedLower = lower.replace(/[?.!]/g, "").trim();
    for (const pat of pureFollowUpPhrases) {
      if (pat.test(cleanedLower)) return true;
    }
  }

  return false;
}

export async function resolveAllEntities(
  message: string,
  history: ChatHistoryItem[],
  sessionName?: string,
  lastEntities?: { lastPerson?: string; lastProject?: string }
): Promise<{ message: string; entities: ResolvedEntities }> {
  const lastPerson = lastEntities?.lastPerson;
  const { message: pronounResolvedMessage, resolvedPerson, resolvedQuality } = resolvePronouns(message, sessionName, lastPerson);

  const raw = await extractRawEntities(pronounResolvedMessage);

  let finalPerson = resolvedPerson || raw.personName;
  const entities: ResolvedEntities = {};

  if (finalPerson) {
    const p = await resolvePersonSafe(finalPerson);
    if (p.value) {
      entities.person = {
        value: p.value,
        quality: p.quality,
        confidence: p.confidence,
        ambiguous: p.ambiguous,
        candidates: p.candidates
      };
    } else if (p.ambiguous) {
      entities.person = {
        value: "",
        quality: p.quality,
        confidence: p.confidence,
        ambiguous: p.ambiguous,
        candidates: p.candidates
      };
    }
  }

  let rawDoc = raw.docTitle;
  if (!rawDoc && lastEntities?.lastProject && isFollowUpNeedingContext(message, history)) {
    rawDoc = lastEntities.lastProject;
  }
  if (rawDoc) {
    const d = await resolveDocumentSafe(rawDoc);
    if (d.value) {
      entities.page = {
        value: d.value,
        url: d.url,
        quality: d.quality
      };
    }
  }

  const dateInfo = resolveDates(pronounResolvedMessage);
  if (dateInfo.year) {
    entities.year = { value: dateInfo.year, quality: ResolutionQuality.EXACT };
  }
  if (dateInfo.dateRange) {
    entities.dateRange = { value: dateInfo.dateRange, quality: ResolutionQuality.EXACT };
  }

  return {
    message: pronounResolvedMessage,
    entities
  };
}

export async function lazyResolveSqlEntities(
  parsed: ParsedQuery,
  history: ChatHistoryItem[] = [],
  sessionName?: string,
  lastEntities?: { lastPerson?: string; lastProject?: string; lastMale?: string; lastFemale?: string }
): Promise<ParsedQuery> {
  const finalParsed = { ...parsed };
  const rawMessage = parsed.raw || "";
  const needsFollowUpContext = isFollowUpNeedingContext(rawMessage, history);

  const needsPerson = [
    "assigned_list",
    "worked_on_list",
    "owner_list",
    "activity_summary",
    "person_project_membership",
    "assignee_project_check"
  ].includes(parsed.kind);
  if (needsPerson) {
    let rawPerson = parsed.personName;
    if (!rawPerson) {
      const extracted = await extractRawEntities(rawMessage);
      rawPerson = extracted.personName;
    }
    if (!rawPerson) {
      const pronounInfo = resolvePronouns(rawMessage, sessionName, lastEntities?.lastPerson);
      if (pronounInfo.resolvedPerson) {
        rawPerson = pronounInfo.resolvedPerson;
      }
    }
    if (!rawPerson && sessionName && /\b(me|my|myself|i)\b/i.test(rawMessage)) {
      rawPerson = sessionName;
    }
    if (!rawPerson && needsFollowUpContext && lastEntities?.lastPerson) {
      rawPerson = lastEntities.lastPerson;
    }

    if (rawPerson) {
      const resolved = await resolvePersonSafe(rawPerson);
      if (resolved.value) {
        finalParsed.personName = resolved.value;
        finalParsed.resolvedEntities = {
          ...finalParsed.resolvedEntities,
          person: {
            value: resolved.value,
            quality: resolved.quality,
            confidence: resolved.confidence,
            ambiguous: resolved.ambiguous,
            candidates: resolved.candidates
          }
        };
      } else if (resolved.ambiguous) {
        finalParsed.personName = "";
        finalParsed.resolvedEntities = {
          ...finalParsed.resolvedEntities,
          person: {
            value: "",
            quality: resolved.quality,
            confidence: resolved.confidence,
            ambiguous: resolved.ambiguous,
            candidates: resolved.candidates
          }
        };
      } else {
        finalParsed.personName = rawPerson;
      }
    }
  }

  const needsDoc = [
    "owner_of",
    "created_by_of",
    "status_of",
    "project_eta",
    "project_manager_of",
    "assigned_list",
    "worked_on_list",
    "activity_summary",
    "team_activity",
    "team_roster",
    "blocker_list",
    "person_project_membership",
    "page_about",
    "project_summary",
    "risks_for",
    "assignee_project_check"
  ].includes(parsed.kind);
  if (needsDoc) {
    let rawDoc = parsed.docTitle;
    if (!rawDoc) {
      const extracted = await extractRawEntities(rawMessage);
      rawDoc = extracted.docTitle;
    }
    const hasProjectPronoun = /\b(it|its|this|that)\b/i.test(rawMessage) || (needsFollowUpContext && !/\b(he|him|his|she|her|hers|they|them|their|me|my|i)\b/i.test(rawMessage));
    if (!rawDoc && hasProjectPronoun && lastEntities?.lastProject) {
      rawDoc = lastEntities.lastProject;
    }
    if (rawDoc) {
      const resolved = await resolveDocumentSafe(rawDoc);
      if (resolved.value) {
        finalParsed.docTitle = resolved.value;
        finalParsed.resolvedEntities = {
          ...finalParsed.resolvedEntities,
          page: {
            value: resolved.value,
            url: resolved.url,
            quality: resolved.quality
          }
        };
      }
    }
  }

  const dateInfo = resolveDates(rawMessage);
  if (dateInfo.year) {
    finalParsed.year = dateInfo.year;
    finalParsed.resolvedEntities = {
      ...finalParsed.resolvedEntities,
      year: { value: dateInfo.year, quality: ResolutionQuality.EXACT }
    };
  }
  if (dateInfo.dateRange) {
    finalParsed.dateRange = dateInfo.dateRange;
    finalParsed.resolvedEntities = {
      ...finalParsed.resolvedEntities,
      dateRange: { value: dateInfo.dateRange, quality: ResolutionQuality.EXACT }
    };
  }

  return finalParsed;
}

export async function lazyResolveRagEntities(
  parsed: ParsedQuery,
  history: ChatHistoryItem[] = [],
  sessionName?: string,
  lastEntities?: { lastPerson?: string; lastProject?: string; lastMale?: string; lastFemale?: string }
): Promise<ParsedQuery> {
  const finalParsed = { ...parsed };
  const rawMessage = parsed.raw || "";
  const needsFollowUpContext = isFollowUpNeedingContext(rawMessage, history);

  let rawPerson = parsed.personName;
  if (!rawPerson) {
    const extracted = await extractRawEntities(rawMessage);
    rawPerson = extracted.personName;
  }
  if (!rawPerson) {
    const pronounInfo = resolvePronouns(rawMessage, sessionName, lastEntities?.lastPerson);
    if (pronounInfo.resolvedPerson) {
      rawPerson = pronounInfo.resolvedPerson;
    }
  }
  if (!rawPerson && sessionName && /\b(me|my|myself|i)\b/i.test(rawMessage)) {
    rawPerson = sessionName;
  }
  if (!rawPerson && needsFollowUpContext && lastEntities?.lastPerson) {
    rawPerson = lastEntities.lastPerson;
  }

  if (rawPerson) {
    const resolved = await resolvePersonSafe(rawPerson);
    if (resolved.value) {
      finalParsed.personName = resolved.value;
      finalParsed.resolvedEntities = {
        ...finalParsed.resolvedEntities,
        person: {
          value: resolved.value,
          quality: resolved.quality,
          confidence: resolved.confidence,
          ambiguous: resolved.ambiguous,
          candidates: resolved.candidates
        }
      };
    } else if (resolved.ambiguous) {
      finalParsed.personName = "";
      finalParsed.resolvedEntities = {
        ...finalParsed.resolvedEntities,
        person: {
          value: "",
          quality: resolved.quality,
          confidence: resolved.confidence,
          ambiguous: resolved.ambiguous,
          candidates: resolved.candidates
        }
      };
    } else {
      finalParsed.personName = rawPerson;
    }
  }

  const needsDoc = ["page_about", "project_summary", "risks_for", "onboarding_tasks"].includes(parsed.kind);
  if (needsDoc) {
    let rawDoc = parsed.docTitle;
    const hasProjectPronoun = /\b(it|its|this|that)\b/i.test(rawMessage) || (needsFollowUpContext && !/\b(he|him|his|she|her|hers|they|them|their|me|my|i)\b/i.test(rawMessage));
    if (!rawDoc && hasProjectPronoun && lastEntities?.lastProject) {
      rawDoc = lastEntities.lastProject;
    }
    if (!rawDoc) {
      const extracted = await extractRawEntities(rawMessage);
      rawDoc = extracted.docTitle;
    }
    if (rawDoc) {
      const resolved = await resolveDocumentSafe(rawDoc);
      if (resolved.value) {
        finalParsed.docTitle = resolved.value;
        finalParsed.resolvedEntities = {
          ...finalParsed.resolvedEntities,
          page: {
            value: resolved.value,
            url: resolved.url,
            quality: resolved.quality
          }
        };
      }
    }
  }

  const dateInfo = resolveDates(rawMessage);
  if (dateInfo.year) {
    finalParsed.year = dateInfo.year;
    finalParsed.resolvedEntities = {
      ...finalParsed.resolvedEntities,
      year: { value: dateInfo.year, quality: ResolutionQuality.EXACT }
    };
  }

  return finalParsed;
}
