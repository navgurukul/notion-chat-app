import { ChatHistoryItem } from "@/lib/ai/gemini";
import { resolvePerson, ResolutionQuality, ResolvedPerson } from "./person";
import { resolveDocument, ResolvedDocument } from "./document";
import type { ParsedQuery } from "@/lib/query/types";
import { getPeopleDirectory } from "@/lib/db/team-members";

export { ResolutionQuality };

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

// Simple timeout utility
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

export function resolveDates(message: string): { year?: number; dateRange?: { dateStart: string | null; dateEnd: string | null } } {
  const q = message.toLowerCase();
  const now = new Date();

  let dateStart: string | null = null;
  let dateEnd: string | null = null;
  let year: number | undefined;

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

  // First-person pronouns
  const firstPersonRegex = /\b(my|me|myself|i)\b/i;
  if (sessionName && firstPersonRegex.test(text)) {
    resolvedPerson = sessionName;
    resolvedQuality = ResolutionQuality.EXACT;
    text = text.replace(/\b(my|me|myself|i)\b/gi, sessionName);
  }

  // Third-person pronouns
  const thirdPersonRegex = /\b(he|him|his|she|her|hers|they|them|their)\b/i;
  if (lastPerson && thirdPersonRegex.test(text)) {
    resolvedPerson = lastPerson;
    resolvedQuality = ResolutionQuality.EXACT;
    text = text.replace(/\b(he|him|his|she|her|hers|they|them|their)\b/gi, lastPerson);
  }

  return { message: text, resolvedPerson, resolvedQuality };
}

export async function extractRawEntities(message: string): Promise<{ personName?: string; docTitle?: string; compareTitleB?: string }> {
  const words = message.trim().split(/\s+/);
  
  let personName: string | undefined;
  let docTitle: string | undefined;
  let compareTitleB: string | undefined;

  // 1. Case-insensitive whitelisted matching from the people directory
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

  // 2. Stop words list to prevent extracting noise words like "there", "is" in fallback
  const STOP_WORDS = new Set([
    "there", "here", "is", "are", "was", "were", "the", "a", "an", "for", "any", "some", "only", "one", 
    "what", "which", "who", "when", "where", "why", "how", "to", "from", "in", "on", "at", "by", "with", 
    "about", "all", "tasks", "task", "project", "projects", "work", "pages", "page", "docs", "doc", "them", 
    "they", "him", "her", "his", "their", "me", "my", "your", "us", "our", "you"
  ]);

  if (!personName) {
    const assignedToMatch = message.match(/\b(?:assigned\s+to|tasks\s+of|by|for)\s+([a-zA-Z][a-zA-Z'.-]*(?:\s+[a-zA-Z][a-zA-Z'.-]*){0,2})\b/i);
    if (assignedToMatch?.[1]) {
      const candidate = assignedToMatch[1].trim();
      if (!STOP_WORDS.has(candidate.toLowerCase())) {
        personName = candidate;
      }
    }
  }

  const docMatch = message.match(/\b(?:about|status\s+of|on|details\s+of|project)\s+([a-zA-Z][a-zA-Z0-9]+(?:\s+[a-zA-Z0-9]+)?)\b/i);
  if (docMatch?.[1]) {
    docTitle = docMatch[1];
  }

  if (!personName) {
    const candidates = words.filter((w, idx) => idx > 0 && /^[a-zA-Z][a-zA-Z'.-]*$/.test(w.replace(/[^a-zA-Z]/g, "")));
    for (const c of candidates) {
      const candidateClean = c.replace(/[^a-zA-Z]/g, "");
      if (candidateClean.length >= 2 && !STOP_WORDS.has(candidateClean.toLowerCase())) {
        personName = candidateClean;
        break;
      }
    }
  }

  return { personName, docTitle, compareTitleB };
}

export async function resolveAllEntities(
  message: string,
  history: ChatHistoryItem[],
  sessionName?: string,
  lastEntities?: { lastPerson?: string; lastProject?: string }
): Promise<{ message: string; entities: ResolvedEntities }> {
  const startTime = performance.now();
  const TIMEOUT_MS = 50;

  const lastPerson = lastEntities?.lastPerson;
  const { message: pronounResolvedMessage, resolvedPerson, resolvedQuality } = resolvePronouns(message, sessionName, lastPerson);

  const raw = await extractRawEntities(pronounResolvedMessage);
  
  let finalPerson = resolvedPerson || raw.personName;
  const entities: ResolvedEntities = {};

  if (finalPerson) {
    const pPromise = resolvePerson(finalPerson).then((p) => {
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
    });
    await withTimeout(pPromise, TIMEOUT_MS, null);
  }

  let rawDoc = raw.docTitle || lastEntities?.lastProject;
  if (rawDoc) {
    const dPromise = resolveDocument(rawDoc).then((d) => {
      if (d.value) {
        entities.page = {
          value: d.value,
          url: d.url,
          quality: d.quality
        };
      }
    });
    await withTimeout(dPromise, TIMEOUT_MS, null);
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
  lastEntities?: { lastPerson?: string; lastProject?: string }
): Promise<ParsedQuery> {
  const finalParsed = { ...parsed };
  const rawMessage = parsed.raw || "";

  // 1. Resolve Person for SQL intents that need a person
  const needsPerson = [
    "assigned_list",
    "worked_on_list",
    "owner_list",
    "activity_summary",
    "person_project_membership"
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
    if (!rawPerson && lastEntities?.lastPerson) {
      rawPerson = lastEntities.lastPerson;
    }

    if (rawPerson) {
      const resolved = await resolvePerson(rawPerson);
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

  // 2. Resolve Document for SQL intents that need a document
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
    "risks_for"
  ].includes(parsed.kind);
  if (needsDoc) {
    let rawDoc = parsed.docTitle;
    if (!rawDoc) {
      const extracted = await extractRawEntities(rawMessage);
      rawDoc = extracted.docTitle;
    }
    if (!rawDoc && lastEntities?.lastProject) {
      rawDoc = lastEntities.lastProject;
    }
    if (rawDoc) {
      const resolved = await resolveDocument(rawDoc);
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

  // 3. Resolve Date/Year
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
  lastEntities?: { lastPerson?: string; lastProject?: string }
): Promise<ParsedQuery> {
  const finalParsed = { ...parsed };
  const rawMessage = parsed.raw || "";

  const needsDoc = ["page_about", "project_summary", "risks_for", "onboarding_tasks"].includes(parsed.kind);
  if (needsDoc) {
    let rawDoc = parsed.docTitle;
    if (!rawDoc && lastEntities?.lastProject) {
      rawDoc = lastEntities.lastProject;
    }
    if (!rawDoc) {
      const extracted = await extractRawEntities(rawMessage);
      rawDoc = extracted.docTitle;
    }
    if (rawDoc) {
      const resolved = await resolveDocument(rawDoc);
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
