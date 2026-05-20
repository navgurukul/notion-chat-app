import { getJsonCompletion } from "@/lib/gemini";
import { extractYearFromQuestion } from "./normalize";
import type { ClassifiedIntent, ParsedQuery, QueryKind } from "./types";

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
  "blocker_list",
  "project_eta",
  "page_about",
  "project_summary",
  "compare_pages",
  "risks_for",
  "onboarding_tasks",
  "semantic",
];

const KIND_SET = new Set<QueryKind>(ALL_KINDS);

const NEEDS_PERSON = new Set<QueryKind>([
  "owner_list",
  "created_by_list",
  "assigned_list",
  "worked_on_list",
  "activity_summary",
]);

const NEEDS_TITLE = new Set<QueryKind>([
  "owner_of",
  "created_by_of",
  "assigned_to_of",
  "project_manager_of",
  "topic_list",
  "type_of",
  "status_of",
  "page_about",
  "project_summary",
  "team_activity",
  "blocker_list",
  "project_eta",
  "risks_for",
]);

function cleanField(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /^(is|was|are|were|only|one|what|who|which|task|tasks)$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function toParsedQuery(question: string, data: ClassifiedIntent): ParsedQuery | null {
  if (!KIND_SET.has(data.intent)) return null;

  const personName = cleanField(data.personName);
  const docTitle = cleanField(data.docTitle);
  const compareTitleB = cleanField(data.compareTitleB);
  const confidence = typeof data.confidence === "number" ? Math.min(1, Math.max(0, data.confidence)) : 0.5;

  if (NEEDS_PERSON.has(data.intent) && !personName) return null;
  if (NEEDS_TITLE.has(data.intent) && !docTitle) return null;
  if (data.intent === "compare_pages" && (!docTitle || !compareTitleB)) return null;

  const year =
    typeof data.year === "number" && data.year >= 2020 && data.year <= 2099
      ? data.year
      : extractYearFromQuestion(question);

  return {
    kind: data.intent,
    personName,
    docTitle,
    compareTitleB,
    year,
    confidence,
    source: "llm",
    raw: question,
  };
}

const SYSTEM_PROMPT = `
You classify questions about a synced Notion workspace into a strict JSON intent for a database router.
Return ONLY JSON. Do not answer the user's question.

Allowed intents (use exactly one):
${ALL_KINDS.join(", ")}

Intent guide:
- status_of: progress/status of a project or topic ("how is Oscar going", "status of Zuvy")
- project_manager_of: who leads/manages/owns a project ("who's leading Oscar MVP", PM of Zuvy)
- assigned_to_of: who is assigned to a specific task/doc title
- assigned_list: list tasks/docs assigned to a person
- worked_on_list: tasks/projects a person worked on
- activity_summary: what project someone is active on, recent work, "what has X been handling"
- owner_list / owner_of: ownership
- page_about: explain/summarize one specific page by title
- project_summary: overview of a program/project area (multiple pages)
- compare_pages: compare two named pages (set docTitle + compareTitleB)
- risks_for: risks/concerns for a product/project
- onboarding_tasks: new hire onboarding checklist
- blocker_list: blockers in a workspace/project
- project_eta: deadline/completion date
- team_activity: most active person in a team/project
- semantic: open-ended why/how, synthesis, or unclear

Rules:
- personName = human name only (not "it", not "the project")
- docTitle = project/page/topic name (Oscar, Zuvy, ReportList, Employee Onboarding Hub)
- compareTitleB = second page name when comparing two pages
- year = 4-digit year if mentioned (e.g. 2026), else null
- confidence = 0.0–1.0 how sure you are
- Prefer a structured intent over semantic when the question clearly maps to SQL lookup
- "Who's leading X" → project_manager_of
- "What has Tamanna been handling recently" → activity_summary, person Tamanna

JSON shape:
{"intent":"...","personName":null,"docTitle":null,"compareTitleB":null,"year":null,"confidence":0.0}
`;

export async function classifyQueryIntent(question: string): Promise<ParsedQuery | null> {
  try {
    const raw = await getJsonCompletion(SYSTEM_PROMPT, question);
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonText.match(/\{[\s\S]*\}/)?.[0] ?? jsonText) as ClassifiedIntent;
    if (!parsed?.intent) return null;
    return toParsedQuery(question, parsed);
  } catch {
    return null;
  }
}
