import { getJsonCompletion } from "@/lib/ai/gemini";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { buildContextualSearchQuery } from "@/lib/chat/history";

const REFORMULATION_SYSTEM_PROMPT = `
You rewrite follow-up questions into ONE standalone search query for NavGurukul's Notion workspace (HRMS, policies, projects, team docs).

Return JSON only:
{ "search_query": "..." }

Rules:
1. Use conversation history to resolve pronouns (e.g., "it", "they", "this task", "that project", "him", "her") to their actual entity names from the history.
2. The search_query must be a standalone search query, NOT a conversational chat message. It does not need to be a grammatically complete question. For example, "Bharat FPO Finder overview" is better than "Can you please tell me more about Bharat FPO Finder?".
3. Explicitly forbid adding extra metadata (assignee, owner, year, status) unless explicitly requested in the follow-up message itself. Never append constraints like "assigned to Mahendra" or "in 2026" unless the user specifically asked for them in the current follow-up question.
4. If the follow-up question is already clear and self-contained, return it cleaned up (same meaning).
5. Do not answer the question — only produce the rewritten query.
6. Plain text only (no markdown, no quotes around the output).
7. Keep the query under 200 characters.
8. Crucial: Do NOT translate, alter, generalize, or paraphrase proper nouns, project names, document titles, or acronyms. For example, "Oscar MVP" must remain exactly "Oscar MVP" (do NOT change to "Oscar project" or "the MVP of Oscar"), and "Zuvy Eval" must remain exactly "Zuvy Eval".

Example 1:
- History: user asked about "Comp-Off Leave Policy", assistant explained backdated rules.
- Follow-up: "Who owns it?"
- search_query: "Who is the owner of the Comp-Off Leave Policy?"

Example 2:
- History: user asked about tasks assigned to Mahendra (e.g. "Bharat FPO Finder").
- Follow-up: "tell me more about this task"
- search_query: "Tell me more about the Bharat FPO Finder task."
`.trim();

import { reformulationCache } from "./cache";

export type QueryReformulationMethod = "original" | "contextual_fallback" | "llm";

export type ReformulatedSearchQuery = {
  searchQuery: string;
  method: QueryReformulationMethod;
};

function formatHistoryForReformulation(history: ChatHistoryItem[]) {
  return history
    .slice(-8)
    .map(
      (item) =>
        `${item.role === "user" ? "User" : "Assistant"}: ${item.content.trim().slice(0, 1500)}`,
    )
    .join("\n\n");
}

function parseReformulationResponse(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
    const parsed = JSON.parse(jsonText) as {
      search_query?: unknown;
      searchQuery?: unknown;
      query?: unknown;
    };

    const candidate = parsed.search_query ?? parsed.searchQuery ?? parsed.query;
    if (typeof candidate !== "string") return null;

    const searchQuery = candidate.trim().slice(0, 500);
    return searchQuery.length > 0 ? searchQuery : null;
  } catch {
    return null;
  }
}

/**
 * History-aware retrieval: rewrite follow-ups into a standalone search query (LLM),
 * then use that query for chunk/page search.
 */
export async function reformulateSearchQuery(
  message: string,
  history: ChatHistoryItem[],
  intentKind?: string,
): Promise<ReformulatedSearchQuery> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { searchQuery: trimmed, method: "original" };
  }

  if (history.length === 0) {
    return { searchQuery: trimmed, method: "original" };
  }

  const cacheKey = JSON.stringify({ message: trimmed, history: history.slice(-4), intentKind });
  const cached = reformulationCache.get(cacheKey);
  if (cached !== undefined) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[query-reformulation] cache hit for key:", cacheKey.slice(0, 100));
    }
    return { searchQuery: cached, method: "llm" };
  }

  if (process.env.QUERY_REFORMULATION === "false") {
    const fallbackVal = buildContextualSearchQuery(trimmed, history);
    return {
      searchQuery: fallbackVal,
      method: "contextual_fallback",
    };
  }

  try {
    let intentInstructions = "";
    if (intentKind) {
      if (intentKind === "status_of") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as a status or progress query for the target project/page.";
      } else if (intentKind === "assigned_list") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as a task assignment list query, preserving any person name or reference.";
      } else if (intentKind === "project_manager_of" || intentKind === "owner_of") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as a project manager, lead, or owner lookup query.";
      } else if (intentKind === "blocker_list") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as a blocker or issue list query for the project.";
      } else if (intentKind === "project_eta") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as an ETA, deadline, or timeline query.";
      } else if (intentKind === "team_activity" || intentKind === "team_roster") {
        intentInstructions = "\n9. Special intent: Rewrite the follow-up question specifically as a team activity or member roster query.";
      }
    }

    const systemPrompt = REFORMULATION_SYSTEM_PROMPT + intentInstructions;

    const userPrompt = [
      "Conversation history:",
      formatHistoryForReformulation(history),
      "",
      `Current user question: ${trimmed}`,
    ].join("\n");

    const raw = await getJsonCompletion(systemPrompt, userPrompt);
    const reformulated = parseReformulationResponse(raw);

    if (reformulated) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[chat] history_aware_query", {
          original: trimmed,
          reformulated,
          intentKind,
        });
      }
      reformulationCache.set(cacheKey, reformulated);
      return { searchQuery: reformulated, method: "llm" };
    }
  } catch (error) {
    console.warn("[chat] query reformulation failed, using contextual fallback:", error);
  }

  return {
    searchQuery: buildContextualSearchQuery(trimmed, history),
    method: "contextual_fallback",
  };
}

export function shouldReformulate(message: string, history: ChatHistoryItem[]): boolean {
  if (history.length === 0) return false;
  const msg = message.toLowerCase();
  const hasPronouns = /\b(he|him|his|she|her|hers|they|them|their|it|this|that|these|those)\b/i.test(msg);
  const hasEllipsis = /^[?!\s]*(?:what|how|and|tell\s+me|show|list)\s+about\s/i.test(msg) || msg.trim().split(/\s+/).length <= 4;
  return hasPronouns || hasEllipsis;
}
