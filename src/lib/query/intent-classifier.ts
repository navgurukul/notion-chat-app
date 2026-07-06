import { getJsonCompletion } from "@/lib/ai/gemini";
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

const SYSTEM_PROMPT = `
You classify questions about NavGurukul's workplace Notion workspace (HRMS, leave policies, projects, onboarding, team docs) into a strict JSON intent kind for a database router.
Return ONLY JSON. Do not answer the user's question. Do NOT extract any entities (names, titles, years) - focus ONLY on the intent kind.

Allowed intents (use exactly one):
${ALL_KINDS.join(", ")}

Intent guide:
- status_of: progress/status of a project or topic ("how is X going", "status of Zuvy")
- project_manager_of: who leads/manages/owns a project ("who's leading Oscar MVP", PM of Zuvy)
- assigned_to_of: who is assigned to a specific task/doc title
- assigned_list: list tasks/docs assigned to a person
- worked_on_list: tasks/projects a person worked on
- activity_summary: what project someone is active on, recent work, "what has X been handling"
- owner_list / owner_of: ownership
- page_about: explain/summarize one specific page by title
- project_summary: overview of a program/project area (multiple pages)
- risks_for: risks/concerns for a product/project
- onboarding_tasks: new hire onboarding checklist
- blocker_list: blockers in a workspace/project
- project_eta: deadline/completion date
- team_activity: most/least active person in a team/project (based on question wording)
- team_roster: who is working on a project (all contributors, not only owner)
- people_list: directory lists, listing all developers, listing all team members ("Who are all developers?", "List team members")
- analytics: statistical aggregation queries ("Which project has the most developers?", "project with most assignees")
- person_project_membership: whether a specific person is working on or associated with a specific project/topic (e.g., "Is Tamanna working on Oscar?", "Does Rahul work on DataPivots?", "Is Amruta part of NavTrack?"). Do NOT use this if the user is asking for a list of projects a person works on without specifying a target project (use worked_on_list instead).
- semantic: open-ended why/how, synthesis, or unclear factual inquiries
- smalltalk: greetings (hi, hello), feedback/comments (thanks, nice, great), casual banter, jokes, playful remarks, laughing (hahaha), statements about feelings/moods, or generic chatbot chit-chat that doesn't seek factual information from Notion.

JSON shape:
{"intent":"...","confidence":0.95}
`;

export async function classifyQueryIntent(question: string): Promise<ParsedQuery | null> {
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
