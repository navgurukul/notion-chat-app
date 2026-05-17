import type { ChatHistoryItem } from "./gemini";

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

export function isNotionLinkRequest(message: string) {
  return (
    /\b(notion\s+)?(link|url)\b/i.test(message) ||
    /\bopen\s+in\s+notion\b/i.test(message) ||
    /\bshare\s+(?:the\s+)?(?:notion\s+)?link\b/i.test(message)
  );
}

/** Resolve a page title from bracket refs, explicit names, or prior chat turns ("link of it"). */
export function extractReferencedTitle(message: string, history: ChatHistoryItem[]) {
  const bracket = message.match(/\[([^\]]+)\]/);
  if (bracket?.[1] && bracket[1].trim().length >= 3) return bracket[1].trim();

  const named =
    message.match(/(?:link|url)\s+(?:of|for|to)\s+(?:the\s+)?(?:page\s+)?["']([^"']+)["']/i) ??
    message.match(/(?:link|url)\s+(?:of|for|to)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (named?.[1]) {
    const title = named[1].trim();
    if (title.length >= 3 && !/^(it|this|that)$/i.test(title)) return title;
  }

  if (!/\b(it|this|that)\b/i.test(message)) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const brackets = history[i].content.match(/\[([^\]]+)\]/g);
    if (brackets?.length) {
      const last = brackets[brackets.length - 1].slice(1, -1).trim();
      if (last.length >= 3) return last;
    }
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "user") continue;
    const line = history[i].content.split("\n")[0]?.trim() ?? "";
    const head = line
      .replace(
        /^(what is|what's|summarize|summary of|explain|describe|tell me about|can i get|give me)\s+/i,
        "",
      )
      .split(/[—–:-]/)[0]
      ?.trim();
    if (head && head.length >= 8 && !isNotionLinkRequest(head)) return head;
  }

  return null;
}

export function resolveSemanticSearchQuery(message: string, history: ChatHistoryItem[]) {
  const title = extractReferencedTitle(message, history);
  if (title && isNotionLinkRequest(message)) return title;
  return buildContextualSearchQuery(message, history);
}
