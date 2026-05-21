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
  const recentUserTurns = history
    .filter((item) => item.role === "user")
    .slice(-3)
    .map((item) => item.content);

  if (recentUserTurns.length === 0) return message;

  return [
    "Conversation context:",
    ...recentUserTurns.map((turn) => `- ${turn}`),
    "",
    `Current question: ${message}`,
  ].join("\n");
}
