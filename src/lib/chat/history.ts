import type { ChatHistoryItem } from "@/lib/ai/gemini";

/** Keep only valid user/bot turns for the LLM (last N messages). */
export function sanitizeChatHistory(value: unknown, maxTurns = 8): ChatHistoryItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is ChatHistoryItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<ChatHistoryItem>;
      return (
        (candidate.role === "user" || candidate.role === "bot") &&
        typeof candidate.content === "string" &&
        candidate.content.trim().length > 0
      );
    })
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
