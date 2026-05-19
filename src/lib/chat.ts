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

const SKIP_BRACKET_TITLE =
  /^(?:open in notion|database:|page:|\[database|untitled)$/i;

const PAGE_QUESTION_PREFIX =
  /^(?:what is|what's|what are|tell me about|can you tell me about|summarize|summary of|explain|describe|structuring)\b/i;

function titleFromUserTurn(content: string) {
  const line = content.split("\n")[0]?.trim() ?? "";
  if (line.length < 8 || isNotionLinkRequest(line)) return null;

  if (PAGE_QUESTION_PREFIX.test(line) || /[—–-]/.test(line)) {
    const head = line
      .replace(
        /^(?:what is|what's|what are|tell me about|can you tell me about|summarize|summary of|explain|describe|give me)\s+(?:the\s+)?/i,
        "",
      )
      .split(/[—–:-]/)[0]
      ?.trim();
    if (head && head.length >= 8) return head;
  }

  if (line.length >= 12 && !/^(who|which|can i get)\b/i.test(line)) {
    return line.split(/[—–:-]/)[0]?.trim() || line;
  }

  return null;
}

/** Resolve a page title from bracket refs, explicit names, or prior chat turns ("link of it"). */
export function extractReferencedTitle(message: string, history: ChatHistoryItem[]) {
  const bracket = message.match(/\[([^\]]+)\]/);
  if (bracket?.[1]) {
    const title = bracket[1].trim();
    if (title.length >= 3 && !SKIP_BRACKET_TITLE.test(title)) return title;
  }

  const named =
    message.match(/(?:link|url)\s+(?:of|for|to)\s+(?:the\s+)?(?:page\s+)?["']([^"']+)["']/i) ??
    message.match(/(?:link|url)\s+(?:of|for|to)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (named?.[1]) {
    const title = named[1].trim();
    if (title.length >= 3 && !/^(it|this|that)$/i.test(title)) return title;
  }

  if (!/\b(it|this|that)\b/i.test(message)) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "user") continue;
    const fromTurn = titleFromUserTurn(history[i].content);
    if (fromTurn) return fromTurn;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== "bot") continue;
    const heading = history[i].content.match(/^##\s+(.+?)(?:\n|$)/m);
    if (heading?.[1]) {
      const title = heading[1].trim();
      if (title.length >= 3) return title;
    }
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const brackets = history[i].content.match(/\[([^\]]+)\]/g);
    if (!brackets?.length) continue;
    for (let j = brackets.length - 1; j >= 0; j -= 1) {
      const last = brackets[j].slice(1, -1).trim();
      if (last.length >= 3 && !SKIP_BRACKET_TITLE.test(last)) return last;
    }
  }

  return null;
}

export function resolveSemanticSearchQuery(message: string, history: ChatHistoryItem[]) {
  const title = extractReferencedTitle(message, history);
  if (title && isNotionLinkRequest(message)) return title;
  return buildContextualSearchQuery(message, history);
}
