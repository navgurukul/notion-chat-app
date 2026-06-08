import { getJsonCompletion } from "@/lib/ai/gemini";
import type { ChatHistoryItem } from "@/lib/ai/gemini";
import { buildContextualSearchQuery } from "@/lib/chat/history";

const REFORMULATION_SYSTEM_PROMPT = `
You rewrite chat questions into ONE standalone search query for NavGurukul's workplace Notion workspace.

This database contains internal docs: HRMS, leave/comp-off policies, employee onboarding, projects, product charters, mentorship, campus programs, design docs, and team processes.

Return JSON only:
{ "search_query": "..." }

Rules:
1. Use conversation history to resolve pronouns (it, they, that, this, the project, the policy).
2. Replace vague references with NavGurukul-specific titles, people, features, or policies from history.
3. The search_query must make sense without reading the conversation.
4. Preserve explicit people names and calendar-year constraints.
5. If the user says "this year", "last year", or a specific year, keep that temporal constraint in the rewritten query.
6. If the question is already clear, return it cleaned up (same meaning).
7. Do not answer the question — only produce the search query.
8. Plain text only (no markdown).
9. Keep search_query under 200 characters.

Example:
- History: user asked about "Comp-Off Leave Policy", assistant explained backdated rules.
- Follow-up: "Who owns it?"
- search_query: "Comp-Off Leave Policy page owner NavGurukul"
`.trim();

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
): Promise<ReformulatedSearchQuery> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { searchQuery: trimmed, method: "original" };
  }

  if (history.length === 0) {
    return { searchQuery: trimmed, method: "original" };
  }

  if (process.env.QUERY_REFORMULATION === "false") {
    return {
      searchQuery: buildContextualSearchQuery(trimmed, history),
      method: "contextual_fallback",
    };
  }

  try {
    const userPrompt = [
      "Conversation history:",
      formatHistoryForReformulation(history),
      "",
      `Current user question: ${trimmed}`,
    ].join("\n");

    const raw = await getJsonCompletion(REFORMULATION_SYSTEM_PROMPT, userPrompt);
    const reformulated = parseReformulationResponse(raw);

    if (reformulated) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[chat] history_aware_query", {
          original: trimmed,
          reformulated,
        });
      }
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
