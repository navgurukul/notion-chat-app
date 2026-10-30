import { getJsonCompletion, type ChatHistoryItem } from "@/lib/ai/openai";
import { reformulationCache } from "@/lib/chat/cache";
import { isFollowUpNeedingContext } from "@/lib/query/entity-resolver";
import { removeWord } from "@/lib/shared/text-utils";
import {
  containsPhrase,
  extractAllBracketContents,
  extractBracketContent,
  extractMarkdownH2Title,
  splitOnTitleSeparators,
  splitWords,
  stripLeadingPrefixes,
  toLower,
} from "@/lib/shared/text-utils";

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
9. Topic Switches: If the current question introduces a completely new standalone topic or document title (e.g., shifting from "leave policy" to "Saturday learning"), do NOT inherit entities, project titles, or constraints from history. Generate a search query focusing solely on the new topic.

Example 1:
- History: user asked about "Comp-Off Leave Policy", assistant explained backdated rules.
- Follow-up: "Who owns it?"
- search_query: "Who is the owner of the Comp-Off Leave Policy?"

Example 2:
- History: user asked about tasks assigned to Mahendra (e.g. "Bharat FPO Finder").
- Follow-up: "tell me more about this task"
- search_query: "Tell me more about the Bharat FPO Finder task."

Example 3:
- History: user asked about "Comp-Off Leave Policy".
- Follow-up: "Saturday learning"
- search_query: "Saturday learning"
`.trim();

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

const LINK_PHRASES = [
  "notion link",
  "notion url",
  "link for",
  "link of",
  "link to",
  "url for",
  "url of",
  "url to",
  " link",
  " url",
  "open in notion",
  "share the link",
  "share link",
];

const SKIP_BRACKET_TITLES = new Set([
  "open in notion",
  "database:",
  "page:",
  "[database",
  "untitled",
]);

const PAGE_QUESTION_PREFIXES = [
  "what is",
  "what's",
  "what are",
  "tell me about",
  "can you tell me about",
  "summarize",
  "summary of",
  "explain",
  "describe",
  "structuring",
];

const MANAGER_QUESTION_STARTS = [
  "who is the project manager",
  "who is the project lead",
  "who is the project owner",
  "who is the manager",
  "who is assigned",
  "which is the project manager",
];

const TITLE_HEAD_PREFIXES = [
  "what is",
  "what's",
  "what are",
  "tell me about",
  "can you tell me about",
  "summarize",
  "summary of",
  "explain",
  "describe",
  "give me",
];

export type QueryReformulationMethod = "original" | "contextual_fallback" | "llm";

export type ReformulatedSearchQuery = {
  searchQuery: string;
  method: QueryReformulationMethod;
};

export type MultiQueryMethod = "disabled" | "primary_only" | "llm" | "fallback";

export type ExpandedSearchQueries = {
  queries: string[];
  method: MultiQueryMethod;
};

// How long we let a reformulation/expansion LLM call run before falling back
// to the cheap heuristic path. Tune against your observed OpenAI p95 latency.
const LLM_CALL_TIMEOUT_MS = 3000;

/**
 * Race a promise against a timeout. Resolves to `null` (instead of rejecting)
 * on timeout or error, so callers can fall through to their heuristic fallback
 * without needing a try/catch at every call site.
 */
function withLlmTimeout<T>(promise: Promise<T>, timeoutMs: number = LLM_CALL_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[query-tools] LLM call timed out after ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        console.warn("[query-tools] LLM call failed:", err);
        resolve(null);
      });
  });
}

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

function sanitizeChatHistoryItem(item: unknown): item is ChatHistoryItem {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Partial<ChatHistoryItem>;
  return (
    (candidate.role === "user" || candidate.role === "bot") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

/** Keep only valid user/bot turns for the LLM (last N messages). */
export function sanitizeChatHistory(value: unknown, maxTurns = 8): ChatHistoryItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(sanitizeChatHistoryItem)
    .slice(-maxTurns)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, 2000),
    }));
}

/** Add recent user turns so follow-up questions keep context for RAG. */
export function buildContextualSearchQuery(message: string, history: ChatHistoryItem[]) {
  const seen = new Set<string>();
  const recentUserTurns = history
    .filter((item) => item.role === "user")
    .map((item) => item.content.trim())
    .filter((turn) => {
      const key = turn.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-2);

  if (recentUserTurns.length === 0) return message;

  const needsContext = /\b(it|this|that|they|them|those|the project|the policy|the page)\b/i.test(
    message,
  );
  if (!needsContext) return message;

  return [
    "Conversation context:",
    ...recentUserTurns.map((turn) => `- ${turn.slice(0, 300)}`),
    "",
    `Current question: ${message}`,
  ].join("\n");
}

export function isNotionLinkRequest(message: string) {
  const lower = toLower(message);
  return LINK_PHRASES.some((phrase) => containsPhrase(lower, phrase));
}

function isSkippedBracketTitle(title: string) {
  const lower = toLower(title);
  if (SKIP_BRACKET_TITLES.has(lower)) return true;
  return lower.startsWith("[database");
}

function hasDashOrColon(text: string) {
  return text.includes("—") || text.includes("–") || text.includes("-") || text.includes(":");
}

function titleFromUserTurn(content: string) {
  const line = content.split("\n")[0]?.trim() ?? "";
  if (line.length < 8 || isNotionLinkRequest(line)) return null;

  const lower = toLower(line);
  if (MANAGER_QUESTION_STARTS.some((start) => lower.startsWith(start))) return null;

  const looksLikePageQuestion =
    PAGE_QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix)) || hasDashOrColon(line);

  if (looksLikePageQuestion) {
    const head = splitOnTitleSeparators(
      stripLeadingPrefixes(line, TITLE_HEAD_PREFIXES),
    )[0];
    if (head && head.length >= 8) return head;
  }

  if (line.length >= 12 && !lower.startsWith("who ") && !lower.startsWith("which ") && !lower.startsWith("can i get")) {
    return splitOnTitleSeparators(line)[0]?.trim() || line;
  }

  return null;
}

function extractTitleFromLinkPhrase(message: string) {
  const lower = toLower(message);

  const quoteMarkers = ['"', "'"];
  for (const quote of quoteMarkers) {
    const linkFor = `link for ${quote}`;
    const urlFor = `url for ${quote}`;
    const index = Math.max(lower.indexOf(linkFor), lower.indexOf(urlFor));
    if (index === -1) continue;

    const quoteStart = message.indexOf(quote, index);
    if (quoteStart === -1) continue;

    const quoteEnd = message.indexOf(quote, quoteStart + 1);
    if (quoteEnd === -1) continue;

    const title = message.slice(quoteStart + 1, quoteEnd).trim();
    if (title.length >= 3) return title;
  }

  const triggers = ["link for ", "link of ", "link to ", "url for ", "url of ", "url to "];
  for (const trigger of triggers) {
    const index = lower.indexOf(trigger);
    if (index === -1) continue;

    let rest = message.slice(index + trigger.length).trim();
    if (rest.toLowerCase().startsWith("the ")) rest = rest.slice(4).trim();
    if (rest.toLowerCase().startsWith("page ")) rest = rest.slice(5).trim();

    const end = Math.min(
      rest.indexOf("?") === -1 ? rest.length : rest.indexOf("?"),
      rest.length,
    );
    const title = rest.slice(0, end).trim();

    const pronouns = new Set(["it", "this", "that"]);
    if (title.length >= 3 && !pronouns.has(toLower(title))) return title;
  }

  return null;
}

function messageUsesPronoun(message: string) {
  const words = splitWords(message).map((w) => toLower(w));
  return words.includes("it") || words.includes("this") || words.includes("that");
}

/** Resolve page title from brackets, explicit text, or chat history ("link for it"). */
export function extractReferencedTitle(message: string, history: ChatHistoryItem[]) {
  const fromBrackets = extractBracketContent(message);
  if (fromBrackets && fromBrackets.length >= 3 && !isSkippedBracketTitle(fromBrackets)) {
    return fromBrackets;
  }

  const fromLinkPhrase = extractTitleFromLinkPhrase(message);
  if (fromLinkPhrase) return fromLinkPhrase;

  if (!messageUsesPronoun(message)) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "user") continue;
    const fromTurn = titleFromUserTurn(history[i].content);
    if (fromTurn) return fromTurn;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "bot") continue;
    const heading = extractMarkdownH2Title(history[i].content);
    if (heading && heading.length >= 3) return heading;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const brackets = extractAllBracketContents(history[i].content);
    for (let j = brackets.length - 1; j >= 0; j -= 1) {
      const title = brackets[j];
      if (title.length >= 3 && !isSkippedBracketTitle(title)) return title;
    }
  }

  return null;
}

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

function getReformulationIntentInstruction(intentKind?: string) {
  if (!intentKind) return "";

  if (intentKind === "status_of") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as a status or progress query for the target project/page.";
  }

  if (intentKind === "assigned_list") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as a task assignment list query, preserving any person name or reference.";
  }

  if (intentKind === "project_manager_of" || intentKind === "owner_of") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as a project manager, lead, or owner lookup query.";
  }

  if (intentKind === "blocker_list") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as a blocker or issue list query for the project.";
  }

  if (intentKind === "project_eta") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as an ETA, deadline, or timeline query.";
  }

  if (intentKind === "team_activity" || intentKind === "team_roster") {
    return "\n9. Special intent: Rewrite the follow-up question specifically as a team activity or member roster query.";
  }

  return "";
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
    const systemPrompt = REFORMULATION_SYSTEM_PROMPT + getReformulationIntentInstruction(intentKind);

    const userPrompt = [
      "Conversation history:",
      formatHistoryForReformulation(history),
      "",
      `Current user question: ${trimmed}`,
    ].join("\n");

    // Race against a timeout so a slow/hung OpenAI call can't stall the whole response.
    const raw = await withLlmTimeout(getJsonCompletion(systemPrompt, userPrompt));
    const reformulated = raw ? parseReformulationResponse(raw) : null;

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
  const msg = message.toLowerCase().trim();
  const hasPronouns = /\b(he|him|his|she|her|hers|they|them|their|it|this|that|these|those)\b/i.test(msg);
  const isElliptical = /^(more\s+details|more\s+info|tell\s+me\s+more|show\s+details|who\s+is\s+the\s+owner|who's\s+the\s+owner|who\s+leads|what's\s+the\s+status)$/i.test(msg);
  
  if (hasPronouns || isElliptical) return true;

  return isFollowUpNeedingContext(message, history);
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

    // Race against a timeout so a slow/hung OpenAI call can't stall the whole response.
    const raw = await withLlmTimeout(getJsonCompletion(MULTI_QUERY_SYSTEM_PROMPT, userPrompt));
    const generated = raw ? parseMultiQueryResponse(raw) : null;

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

const UNIFIED_REFORMULATE_EXPAND_SYSTEM_PROMPT = `
You process user questions for NavGurukul's workplace Notion workspace (HRMS, leave policies, projects, onboarding, team docs).

Return JSON only:
{
  "search_query": "standalone primary search query",
  "search_queries": ["query variant 1", "query variant 2", "query variant 3"]
}

Rules:
1. "search_query": Use conversation history to resolve pronouns ("it", "they", "this task", "that project") into their actual entity names from history. Must be a standalone search query.
2. "search_queries": Generate 2 to 3 short query variations from different angles (synonyms, related page titles, policy names, acronyms).
3. Do NOT translate or paraphrase proper nouns or project names (e.g. "Oscar MVP" stays "Oscar MVP").
4. If the question is standalone, return it cleaned up.
5. Do not answer the question — return only search strings in JSON.
`.trim();

export type UnifiedSearchQuery = {
  searchQuery: string;
  queries: string[];
  reformulationMethod: QueryReformulationMethod;
  multiQueryMethod: MultiQueryMethod;
};

export async function reformulateAndExpand(
  message: string,
  history: ChatHistoryItem[],
  intentKind?: string,
  skipExpansion: boolean = false
): Promise<UnifiedSearchQuery> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { searchQuery: trimmed, queries: [trimmed], reformulationMethod: "original", multiQueryMethod: "disabled" };
  }

  const needsReformulation = shouldReformulate(trimmed, history);

  if (!needsReformulation && skipExpansion) {
    return { searchQuery: trimmed, queries: [trimmed], reformulationMethod: "original", multiQueryMethod: "disabled" };
  }

  if (!needsReformulation) {
    const expanded = await expandSearchQueries(trimmed, history, trimmed, intentKind);
    return {
      searchQuery: trimmed,
      queries: expanded.queries,
      reformulationMethod: "original",
      multiQueryMethod: expanded.method,
    };
  }

  if (skipExpansion) {
    const reformulated = await reformulateSearchQuery(trimmed, history, intentKind);
    return {
      searchQuery: reformulated.searchQuery,
      queries: [reformulated.searchQuery],
      reformulationMethod: reformulated.method,
      multiQueryMethod: "disabled",
    };
  }

  try {
    const systemPrompt = UNIFIED_REFORMULATE_EXPAND_SYSTEM_PROMPT + getReformulationIntentInstruction(intentKind);
    const userPrompt = [
      "Conversation history:",
      formatHistoryForReformulation(history),
      "",
      `Current user question: ${trimmed}`,
    ].join("\n");

    const raw = await withLlmTimeout(getJsonCompletion(systemPrompt, userPrompt));
    if (raw) {
      const jsonText = raw.trim().match(/\{[\s\S]*\}/)?.[0] ?? raw;
      const parsed = JSON.parse(jsonText) as { search_query?: string; search_queries?: string[] };

      const searchQuery = parsed.search_query?.trim() || buildContextualSearchQuery(trimmed, history);
      const rawQueries = Array.isArray(parsed.search_queries) ? parsed.search_queries : [];
      const queries = normalizeQueries([searchQuery, ...rawQueries]).slice(0, readQueryCount());

      return {
        searchQuery,
        queries: queries.length > 0 ? queries : [searchQuery],
        reformulationMethod: "llm",
        multiQueryMethod: "llm",
      };
    }
  } catch (error) {
    console.warn("[query-tools] unified reformulate and expand failed, falling back:", error);
  }

  const fallbackReform = await reformulateSearchQuery(trimmed, history, intentKind);
  return {
    searchQuery: fallbackReform.searchQuery,
    queries: [fallbackReform.searchQuery],
    reformulationMethod: fallbackReform.method,
    multiQueryMethod: "fallback",
  };
}