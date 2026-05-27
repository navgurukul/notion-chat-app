export type ChatHistoryItem = {
  role: "user" | "bot";
  content: string;
};

type ChatStreamChunk = { text: () => string };
export type ChatStream = AsyncIterable<ChatStreamChunk>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getOpenAIChatModel(): string {
  // Allows the project to keep using embeddings key while selecting a chat model separately.
  return (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini").trim();
}

function formatConversationHistory(history: ChatHistoryItem[] = []) {
  const recentHistory = history
    .filter((item) => item.content.trim())
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content.trim()}`)
    .join("\n\n");

  return recentHistory || "No previous conversation in this chat.";
}

type SystemPromptOptions = {
  streaming?: boolean;
};

function buildSystemPrompt(
  context: string,
  history: ChatHistoryItem[] = [],
  options: SystemPromptOptions = {},
) {
  const streamingInstruction = options.streaming
    ? `
    Response format: reply directly in markdown for the user.
    Do not use [[THINKING]], [[ANSWER]], or other XML-style tags.
    Do not include internal reasoning (e.g. "I will scan the chunks", "The user is asking").
    Start with the answer immediately.
  `
    : "";

  return `
    You are a helpful assistant for NavGurukul's synced Notion workspace.
    The context below contains real page titles, URLs, status, owners, and body text from PostgreSQL.
    Use the conversation history only for follow-ups and pronouns — not as facts.

    RULES:
    1. Answer ONLY from the retrieved context. Do not invent facts, people, dates, or amounts.
    2. Start with a direct answer in 1–2 sentences, then ### sections with bullets (max 6–8 per section).
    3. Every important claim must be supported by the context. End with **Sources:** listing page titles as markdown links from the context.
    4. If context is partial, say what you found and what is missing — do not guess.
    5. Only if the context has zero relevant pages, say: "I couldn't find this in the current Notion data."
    6. Page titles may include emoji; treat them as the same page name without emoji.

    ${streamingInstruction}

    Conversation history:
    ---
    ${formatConversationHistory(history)}
    ---

    Retrieved Notion context (chunks):
    ---
    ${context}
    ---
  `;
}

function createTextChunk(text: string): ChatStreamChunk {
  return { text: () => text };
}

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number }).status;
  return typeof status === "number" && RETRYABLE_STATUS_CODES.has(status);
}

async function withRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = Number(process.env.OPENAI_MAX_ATTEMPTS || 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts) break;

      const delayMs = 500 * 2 ** (attempt - 1);
      if (process.env.NODE_ENV !== "production") {
        console.warn(`${label} failed with retryable error. Retrying in ${delayMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

async function createHttpError(response: Response): Promise<HttpError> {
  let message = response.statusText || `HTTP ${response.status}`;

  try {
    const data = (await response.json()) as {
      error?: { message?: string };
    };
    if (typeof data?.error?.message === "string") {
      message = data.error.message;
    }
  } catch {
    // ignore json parsing errors
  }

  return new HttpError(response.status, message);
}

function buildMessages(prompt: string, context: string, history: ChatHistoryItem[], options?: SystemPromptOptions) {
  return [
    { role: "system", content: buildSystemPrompt(context, history, options) },
    { role: "user", content: prompt },
  ];
}

export async function getChatResponse(
  prompt: string,
  context: string,
  history: ChatHistoryItem[] = [],
) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = getOpenAIChatModel();

  const messages = buildMessages(prompt, context, history);

  const result = await withRetry(
    async () => {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: Number(process.env.OPENAI_CHAT_MAX_TOKENS || 600),
        }),
      });

      if (!response.ok) throw await createHttpError(response);
      return response;
    },
    "OpenAI generateContent",
  );

  const data = (await result.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response missing content.");
  return content;
}

export async function getJsonCompletion(systemPrompt: string, prompt: string) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = getOpenAIChatModel();

  const result = await withRetry(
    async () => {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: Number(process.env.OPENAI_JSON_MAX_TOKENS || 220),
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) throw await createHttpError(response);
      return response;
    },
    "OpenAI JSON completion",
  );

  const data = (await result.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI JSON response missing content.");
  return content;
}

function parseOpenAISseDataLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

export async function getChatStream(
  prompt: string,
  context: string,
  history: ChatHistoryItem[] = [],
): Promise<ChatStream> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = getOpenAIChatModel();

  const systemPrompt = buildSystemPrompt(context, history, { streaming: true });
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  async function* streamGenerator(): AsyncGenerator<ChatStreamChunk> {
    const response = await withRetry(
      async () => {
        const res = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_tokens: Number(process.env.OPENAI_CHAT_MAX_TOKENS || 600),
            stream: true,
          }),
        });
        if (!res.ok) throw await createHttpError(res);
        return res;
      },
      "OpenAI generateContentStream",
    );

    if (!response.body) {
      throw new Error("OpenAI response missing stream body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE usually delimited by blank lines.
      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex >= 0) {
        const eventBlock = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        delimiterIndex = buffer.indexOf("\n\n");

        for (const line of eventBlock.split("\n")) {
          const parsed = parseOpenAISseDataLine(line);
          if (!parsed) continue;

          const delta = (parsed as any)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield createTextChunk(delta);
          }
        }
      }
    }
  }

  return streamGenerator();
}

