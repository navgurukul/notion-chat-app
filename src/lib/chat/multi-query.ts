import { getJsonCompletion } from "@/lib/ai/openai";
import { removeWord } from "@/lib/shared/text-utils";
import type { ChatHistoryItem } from "@/lib/ai/openai";

const MULTI_QUERY_SYSTEM_PROMPT = `
You generate multiple search queries for NavGurukul's workplace Notion workspace (HRMS, leave policies, projects, onboarding, team docs).

Return JSON only:
{ "search_queries": ["...", "...", "..."] }

Rules:
1. Produce 2 to 4 short search queries that approach the user's question from different angles (synonyms, related page titles, policy names, acronyms).
2. For synonyms, encourage generating diverse synonyms (e.g. generate "PTO" and "vacation" for "leave") to cover different possible page titles and contents.
3. Crucially, avoid minor spelling/suffix duplicates or near-duplicates (e.g. do not generate both "leave policy" and "leave policies" or "work rules" and "working rules"). Each query must target conceptually distinct keywords or synonyms to retrieve different Notion pages.
4. Include the main topic in at least one query; use NavGurukul-specific terms from history when relevant.
5. Preserve explicit people names and years if the primary query includes them.
6. Each query must stand alone (no pronouns like "it" or "that").
7. Do not answer the question — only search strings.
8. Plain text only (no markdown). Max 120 characters per query.

Example — user: "How does leave work with comp-off and slack?"
search_queries: [
  "comp-off leave policy NavGurukul",
  "leave updates slack discord scenarios",
  "HRMS leave attendance rules"
]
`.trim();

export type MultiQueryMethod = "disabled" | "primary_only" | "llm" | "fallback";

export type ExpandedSearchQueries = {
  queries: string[];
  method: MultiQueryMethod;
};

function readQueryCount() {
  const parsed = Number(process.env.MULTI_QUERY_COUNT);
  if (Number.isFinite(parsed) && parsed >= 2 && parsed <= 5) return Math.floor(parsed);
  return 3;
}

export function isMultiQueryRagEnabled() {
  return process.env.MULTI_QUERY_RAG === "true";
}

function normalizeQueries(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    const q = item.trim().slice(0, 200);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }

  return out;
}

function parseMultiQueryResponse(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
    const parsed = JSON.parse(jsonText) as {
      search_queries?: unknown;
      searchQueries?: unknown;
      queries?: unknown;
    };

    const list = parsed.search_queries ?? parsed.searchQueries ?? parsed.queries;
    if (!Array.isArray(list)) return null;

    const strings = list.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? normalizeQueries(strings) : null;
  } catch {
    return null;
  }
}

function heuristicVariants(primary: string): string[] {
  const cleaned = primary.trim();
  if (!cleaned) return [];

  const variants = new Set<string>([cleaned]);

  const withoutNav = removeWord(cleaned, "navgurukul");
  if (withoutNav.length >= 4) variants.add(withoutNav);

  const words = cleaned.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length > 4) {
    variants.add(words.slice(0, 4).join(" "));
  }

  return normalizeQueries([...variants]).slice(0, readQueryCount());
}

/**
 * v2 Multi-Query RAG: expand one reformulated query into several retrieval queries.
 * When disabled, returns only the primary query.
 */
export async function expandSearchQueries(
  message: string,
  history: ChatHistoryItem[],
  primaryQuery: string,
  intentKind?: string,
): Promise<ExpandedSearchQueries> {
  const primary = primaryQuery.trim() || message.trim();
  if (!primary) {
    return { queries: [], method: "primary_only" };
  }

  let targetCount = readQueryCount();
  if (intentKind) {
    if (intentKind === "page_about" || intentKind === "status_of" || intentKind === "status" || intentKind === "owner_of" || intentKind === "project_manager_of") {
      targetCount = 1;
    } else if (intentKind === "project_summary") {
      targetCount = 2;
    } else if (intentKind === "semantic") {
      targetCount = 4;
    }
  }

  if (targetCount <= 1 || !isMultiQueryRagEnabled()) {
    return { queries: [primary], method: "disabled" };
  }

  try {
    const historyBlock =
      history.length > 0
        ? history
            .slice(-6)
            .map(
              (item) =>
                `${item.role === "user" ? "User" : "Assistant"}: ${item.content.trim().slice(0, 800)}`,
            )
            .join("\n\n")
        : "(none)";

    const userPrompt = [
      "Conversation history:",
      historyBlock,
      "",
      `Current user question: ${message.trim()}`,
      `Primary search query (include or refine): ${primary}`,
      "",
      `Return ${targetCount} search queries in JSON.`,
    ].join("\n");

    const raw = await getJsonCompletion(MULTI_QUERY_SYSTEM_PROMPT, userPrompt);
    const generated = parseMultiQueryResponse(raw);

    if (generated?.length) {
      const withPrimary = normalizeQueries([primary, ...generated]).slice(0, targetCount);
      if (process.env.NODE_ENV !== "production") {
        console.log("[chat] multi_query_rag", { primary, queries: withPrimary });
      }
      return { queries: withPrimary, method: "llm" };
    }
  } catch (error) {
    console.warn("[chat] multi-query generation failed, using heuristics:", error);
  }

  const fallback = heuristicVariants(primary);
  return {
    queries: fallback.length ? fallback : [primary],
    method: "fallback",
  };
}
