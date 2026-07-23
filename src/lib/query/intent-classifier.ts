import { getJsonCompletion } from "@/lib/ai/openai";
import type { ParsedQuery, QueryKind } from "./types";

const ALL_KINDS: QueryKind[] = [
  "owner_list",
  "owner_of",
  "created_by_list",
  "created_by_of",
  "assigned_list",
  "assigned_to_of",
  "worked_on_list",
  "project_manager_of",
  "topic_list",
  "type_of",
  "status_of",
  "activity_summary",
  "team_activity",
  "team_roster",
  "blocker_list",
  "project_eta",
  "page_about",
  "project_summary",
  "risks_for",
  "onboarding_tasks",
  "people_list",
  "analytics",
  "semantic",
  "smalltalk",
  "person_project_membership",
  "assignee_project_check",
];

const KIND_SET = new Set<QueryKind>(ALL_KINDS);

type ClassifiedIntent = {
  intent: QueryKind;
  confidence: number;
};

type CacheEntry = {
  value: ParsedQuery | null;
  expiry: number;
};

const intentCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 1000;

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of intentCache.entries()) {
    if (now > entry.expiry) {
      intentCache.delete(key);
    }
  }
}

// --- FAST-PATH: date + task queries -------------------------------------
// LLM classifier has no few-shot example for "<date> what task do I have"
// style queries, so it sometimes falls back to "semantic" -> RAG search,
// which can mismatch against unrelated docs that happen to repeat the
// word "task" (e.g. Employee Onboarding Hub). Task-list intent with a
// date attached is unambiguous enough to resolve with a regex before
// ever calling the LLM, so we short-circuit it here.
const DATE_PATTERN =
  /\b(\d{1,2}(st|nd|rd|th)?[\s\-\/]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-\/]?\d{2,4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\btoday\b|\btomorrow\b|\byesterday\b)/i;

const TASK_QUERY_PATTERN =
  /\b(task|tasks|to[\s-]?do|assigned)\b/i;

function tryFastPathIntent(question: string): ParsedQuery | null {
  const hasDate = DATE_PATTERN.test(question);
  const hasTaskWord = TASK_QUERY_PATTERN.test(question);

  if (hasDate && hasTaskWord) {
    return {
      kind: "assigned_list",
      confidence: 1.0,
      source: "rule",
      raw: question,
    };
  }

  return null;
}
// --------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You classify questions about NavGurukul's workplace Notion workspace (HRMS, leave policies, projects, onboarding, team docs) into a strict JSON intent kind for a database router.
Return ONLY JSON. Do not answer the user's question. Do NOT extract any entities (names, titles, years) - focus ONLY on the intent kind.

Allowed intents (use exactly one):
${ALL_KINDS.join(", ")}

Intent guide:
- status_of: progress/status of a project or topic ("how is X going", "status of Zuvy")
- project_manager_of: who leads/manages/owns a project ("who's leading Oscar MVP", PM of Zuvy)
- assigned_to_of: who is assigned to a specific task/doc title
- assigned_list: list tasks/docs assigned to a person, INCLUDING when a specific date is mentioned
  ("what task do I have for today", "22 jul 2026 what task i have to do", "tasks for Tamanna on 15 sep 2025")
  -> a date attached to a task question is still assigned_list, NOT semantic or onboarding_tasks.
- worked_on_list: tasks/projects a person worked on
- activity_summary: what project someone is active on, recent work, "what has X been handling"
- owner_list / owner_of: ownership
- page_about: explain/summarize one specific page by title
- project_summary: overview of a program/project area (multiple pages)
- risks_for: risks/concerns for a product/project
- onboarding_tasks: new hire onboarding checklist (only when the question is explicitly about onboarding/new hires, not just because it contains the word "task")
- blocker_list: blockers in a workspace/project
- project_eta: deadline/completion date
- team_activity: most/least active person in a team/project (based on question wording)
- team_roster: who is working on a project (all contributors, not only owner)
- people_list: directory lists, listing all developers, listing all team members ("Who are all developers?", "List team members")
- analytics: statistical aggregation queries ("Which project has the most developers?", "project with most assignees")
- assignee_project_check: whether a specific person is working on or associated with a specific project/topic (e.g., "Is Tamanna working on Oscar?", "Does Rahul work on DataPivots?", "Is Amruta part of NavTrack?"). Do NOT use this if the user is asking for a list of projects a person works on without specifying a target project (use worked_on_list instead).
- person_project_membership: whether a specific person is working on or associated with a specific project/topic (fallback/alias for assignee_project_check).
- semantic: open-ended why/how, synthesis, or unclear factual inquiries
- smalltalk: greetings (hi, hello), feedback/comments (thanks, nice, great), casual banter, jokes, playful remarks, laughing (hahaha), statements about feelings/moods, or generic chatbot chit-chat that doesn't seek factual information from Notion.
  Examples:
  * "good morning!" -> {"intent":"smalltalk","confidence":1.0}
  * "who are you?" -> {"intent":"smalltalk","confidence":0.98}
  * "what is your name?" -> {"intent":"smalltalk","confidence":0.95}
  * "tell me a joke" -> {"intent":"smalltalk","confidence":0.9}
  * "greetings assistant" -> {"intent":"smalltalk","confidence":1.0}
  * "haha that's funny" -> {"intent":"smalltalk","confidence":0.95}
  * "thank you so much!" -> {"intent":"smalltalk","confidence":1.0}
  * "bye bye" -> {"intent":"smalltalk","confidence":1.0}
  * "how are you doing today?" -> {"intent":"smalltalk","confidence":0.98}
  * "22 jul 2026 what task i have to do" -> {"intent":"assigned_list","confidence":0.97}
`;

export async function classifyQueryIntent(question: string): Promise<ParsedQuery | null> {
  // Rule-based fast path first: cheaper, deterministic, and avoids the
  // LLM ambiguity that caused date-attached task queries to leak into
  // semantic/RAG search.
  const fastPath = tryFastPathIntent(question);
  if (fastPath) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[intent-classifier] fast-path hit for:", question, "->", fastPath.kind);
    }
    return fastPath;
  }

  const key = question.trim().toLowerCase();
  cleanCache();

  const cached = intentCache.get(key);
  if (cached && Date.now() < cached.expiry) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[intent-classifier] cache hit for:", key);
    }
    return cached.value;
  }

  try {
    const raw = await getJsonCompletion(SYSTEM_PROMPT, question);
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonText.match(/\{[\s\S]*\}/)?.[0] ?? jsonText) as ClassifiedIntent;

    if (!parsed?.intent || !KIND_SET.has(parsed.intent)) {
      if (intentCache.size >= MAX_CACHE_SIZE) intentCache.clear();
      intentCache.set(key, { value: null, expiry: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;
    const result: ParsedQuery = {
      kind: parsed.intent,
      confidence,
      source: "llm",
      raw: question,
    };

    if (intentCache.size >= MAX_CACHE_SIZE) {
      const firstKey = intentCache.keys().next().value;
      if (firstKey !== undefined) intentCache.delete(firstKey);
    }
    intentCache.set(key, { value: result, expiry: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (error) {
    console.error("[intent-classifier] error:", error);
    if (intentCache.size >= MAX_CACHE_SIZE) intentCache.clear();
    intentCache.set(key, { value: null, expiry: Date.now() + CACHE_TTL_MS });
    return null;
  }
}