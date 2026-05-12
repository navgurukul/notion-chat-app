import { getJsonCompletion } from "@/lib/gemini";
import type { ParsedQuery, QueryKind } from "@/lib/query-router";

const STRUCTURED_QUERY_PATTERN =
  /\b(who|what|which|whose|assigned|assignee|owner|owned|created|creator|status|type|kind|manager|lead|pm|worked|working|tasks?|projects?|docs?|documents?)\b/i;

const ALLOWED_KINDS = new Set<QueryKind>([
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
  "semantic",
]);

const INTENTS_REQUIRING_PERSON = new Set<QueryKind>([
  "owner_list",
  "created_by_list",
  "assigned_list",
  "worked_on_list",
]);

const INTENTS_REQUIRING_TITLE = new Set<QueryKind>([
  "owner_of",
  "created_by_of",
  "assigned_to_of",
  "project_manager_of",
  "topic_list",
  "type_of",
  "status_of",
]);

type AiQueryIntent = {
  intent?: string;
  personName?: string | null;
  docTitle?: string | null;
  confidence?: number;
};

function cleanText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function shouldVerifyQuery(question: string, parsed: ParsedQuery) {
  if (process.env.AI_QUERY_VERIFIER === "false") return false;
  if (!STRUCTURED_QUERY_PATTERN.test(question)) return false;

  if (parsed.kind === "semantic") return true;
  if (parsed.personName && /^(is|was|are|were|only|one|what|who|which)$/i.test(parsed.personName)) {
    return true;
  }
  if (parsed.docTitle && /^(is|was|are|were|got|only|one|what|who|which)$/i.test(parsed.docTitle)) {
    return true;
  }

  return [
    "assigned_list",
    "worked_on_list",
    "project_manager_of",
    "owner_of",
    "status_of",
    "type_of",
  ].includes(parsed.kind);
}

function toParsedQuery(question: string, aiIntent: AiQueryIntent, fallback: ParsedQuery): ParsedQuery {
  const kind = aiIntent.intent as QueryKind | undefined;
  if (!kind || !ALLOWED_KINDS.has(kind)) return fallback;
  if (kind === "semantic") return { kind: "semantic", raw: question };

  const personName = cleanText(aiIntent.personName);
  const docTitle = cleanText(aiIntent.docTitle);

  if (INTENTS_REQUIRING_PERSON.has(kind) && !personName) return fallback;
  if (INTENTS_REQUIRING_TITLE.has(kind) && !docTitle) return fallback;

  return {
    kind,
    personName,
    docTitle,
    raw: question,
  };
}

export async function verifyQueryWithAI(
  question: string,
  parsedByRules: ParsedQuery,
): Promise<ParsedQuery> {
  if (!shouldVerifyQuery(question, parsedByRules)) return parsedByRules;

  const systemPrompt = `
You convert a user's Notion search question into strict JSON for a database router.
Return only JSON. Do not answer the question.

Allowed intents:
- owner_list: list docs owned by a person
- owner_of: ask who owns one topic/doc
- created_by_list: list docs created by a person
- created_by_of: ask who created one topic/doc
- assigned_list: list tasks/docs assigned to a person, optionally filtered by topic
- assigned_to_of: ask who one task/doc is assigned to
- worked_on_list: list docs/tasks a person worked on or is mentioned in
- project_manager_of: ask project manager, project lead, PM, or project owner of a topic/project
- topic_list: list docs/data about a topic
- type_of: ask type/kind of one doc/topic
- status_of: ask status of one doc/topic
- semantic: broad summary, explanation, comparison, why/how question, or unclear intent

Rules:
- Extract personName only when the question clearly names a person.
- Extract docTitle as the topic/project/document name.
- Never use words like "is", "what", "who", "only one", "task", or "project" as personName/docTitle.
- For "who is the project manager of zuvy", intent is "project_manager_of", docTitle is "zuvy".
- For "only one task of datapivot assigned to sanjana", intent is "assigned_list", personName is "sanjana", docTitle is "datapivot".
- For summaries/explanations, use "semantic".

JSON shape:
{"intent":"...","personName":null,"docTitle":null,"confidence":0.0}
`;

  try {
    const raw = await getJsonCompletion(systemPrompt, question);
    const parsed = JSON.parse(raw) as AiQueryIntent;
    const verified = toParsedQuery(question, parsed, parsedByRules);

    if (process.env.NODE_ENV !== "production") {
      console.log("[chat] ai_query_verifier=", { raw: parsed, verified });
    }

    return verified;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[chat] ai_query_verifier_failed=", error);
    }
    return parsedByRules;
  }
}
