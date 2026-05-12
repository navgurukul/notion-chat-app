import { GoogleGenerativeAI } from "@google/generative-ai";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

export type ChatHistoryItem = {
  role: "user" | "bot";
  content: string;
};

type AIProvider = "gemini" | "deepseek";
type ChatStreamChunk = { text: () => string };
export type ChatStream = AsyncIterable<ChatStreamChunk>;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let geminiClient: GoogleGenerativeAI | null = null;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getAIProvider(): AIProvider {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "gemini" || provider === "deepseek") {
    return provider;
  }
  throw new Error(`Unsupported AI_PROVIDER "${provider}". Use "gemini" or "deepseek".`);
}

function getGeminiClient() {
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(requireEnv("GEMINI_API_KEY"));
  }
  return geminiClient;
}

function getGeminiModel() {
  return requireEnv("GEMINI_MODEL");
}

function getDeepSeekApiKey() {
  return requireEnv("DEEPSEEK_API_KEY");
}

function getDeepSeekModel() {
  return requireEnv("DEEPSEEK_MODEL");
}

function formatConversationHistory(history: ChatHistoryItem[] = []) {
  const recentHistory = history
    .filter((item) => item.content.trim())
    .slice(-8)
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
    Response format (required):
    [[THINKING]]
    Provide a brief, high-level summary of your reasoning in 1-3 short sentences. Do not reveal step-by-step chain-of-thought.
    [[/THINKING]]

    [[ANSWER]]
    Your final response for the user.
    [[/ANSWER]]

    Each tag must be on its own line. Output the THINKING section first, then the ANSWER. Do not output anything outside these tags.
  `
    : "";

  return `
    You are an AI assistant that answers questions using NavGurukul's Notion documentation.
    Use only the retrieved context below. Synthesize across all relevant chunks before answering.
    Use the conversation history to understand follow-up questions, pronouns, and references, but do not treat chat history as factual Notion context.
    For broad or in-depth questions, give a structured answer with concrete details from the docs.
    Include document titles or URLs when the context contains them.
    If the user asks for counts, totals, complete lists, or comparisons, explain whether the retrieved context is enough to answer completely. Do not invent totals.
    If the context is incomplete, say what is missing instead of guessing.

    RULES:
    1. Answer from the retrieved context as best as you can. Use any relevant information you find.
    2. Do not invent facts, names, counts, or dates not present in the context.
    3. Only say "I couldn't find this in the available Notion data. The information may exist in Notion but wasn't retrieved." if the context has absolutely nothing relevant to the question.
    4. NEVER say data "does not exist" or "there are no documents" because this context can be partial.

    ${streamingInstruction}

    Conversation history:
    ---
    ${formatConversationHistory(history)}
    ---

    Retrieved Notion context:
    ---
    ${context}
    ---
  `;
}

function isRetryableError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = String((error as { message?: string }).message || "");
  if (/quota exceeded|free_tier_requests|per day/i.test(message)) return false;

  const status = (error as { status?: number }).status;
  return typeof status === "number" && RETRYABLE_STATUS_CODES.has(status);
}

async function withRetry<T>(operation: () => Promise<T>, label: string) {
  const maxAttempts = Number(process.env.GEMINI_MAX_ATTEMPTS || 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts) break;

      const delayMs = 500 * 2 ** (attempt - 1);
      if (process.env.NODE_ENV !== "production") {
        console.warn(`${label} failed with a retryable error. Retrying in ${delayMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function createTextChunk(text: string): ChatStreamChunk {
  return { text: () => text };
}

async function createHttpError(response: Response) {
  let message = response.statusText || `HTTP ${response.status}`;
  const bodyText = await response.text();

  if (bodyText) {
    try {
      const data = JSON.parse(bodyText) as { error?: { message?: string } };
      if (typeof data?.error?.message === "string") {
        message = data.error.message;
      } else {
        message = bodyText;
      }
    } catch {
      message = bodyText;
    }
  }

  return new HttpError(response.status, message);
}

function buildDeepSeekMessages(
  prompt: string,
  context: string,
  history: ChatHistoryItem[],
  options: SystemPromptOptions = {},
) {
  return [
    { role: "system", content: buildSystemPrompt(context, history, options) },
    { role: "user", content: prompt },
  ];
}

function buildDeepSeekJsonMessages(systemPrompt: string, prompt: string) {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
}

async function requestDeepSeek(payload: unknown) {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getDeepSeekApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  return response;
}

async function getDeepSeekResponse(prompt: string, context: string, history: ChatHistoryItem[]) {
  const response = await withRetry(
    () =>
      requestDeepSeek({
        model: getDeepSeekModel(),
        messages: buildDeepSeekMessages(prompt, context, history),
      }),
    "DeepSeek generateContent",
  );

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek response missing content.");
  }
  return content;
}

async function* getDeepSeekStream(
  prompt: string,
  context: string,
  history: ChatHistoryItem[],
): AsyncGenerator<ChatStreamChunk> {
  const response = await withRetry(
    () =>
      requestDeepSeek({
        model: getDeepSeekModel(),
        messages: buildDeepSeekMessages(prompt, context, history, { streaming: true }),
        stream: true,
      }),
    "DeepSeek generateContentStream",
  );

  if (!response.body) {
    throw new Error("DeepSeek response missing stream body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!rawLine || !rawLine.startsWith("data:")) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === "[DONE]") {
        return;
      }

      try {
        const data = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = data?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield createTextChunk(delta);
        }
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("DeepSeek stream chunk parse error:", error);
        }
      }
    }
  }
}

export async function getChatResponse(
  prompt: string,
  context: string,
  history: ChatHistoryItem[] = [],
) {
  try {
    const provider = getAIProvider();
    if (provider === "deepseek") {
      return await getDeepSeekResponse(prompt, context, history);
    }

    const model = getGeminiClient().getGenerativeModel({
      model: getGeminiModel(),
    });

    const result = await withRetry(
      () => model.generateContent([buildSystemPrompt(context, history), prompt]),
      "Gemini generateContent",
    );
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("AI Error:", error);
    throw error;
  }
}

export async function getJsonCompletion(systemPrompt: string, prompt: string) {
  const provider = getAIProvider();

  if (provider === "deepseek") {
    const response = await withRetry(
      () =>
        requestDeepSeek({
          model: getDeepSeekModel(),
          messages: buildDeepSeekJsonMessages(systemPrompt, prompt),
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 220,
        }),
      "DeepSeek JSON completion",
    );

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek JSON response missing content.");
    return content;
  }

  const model = getGeminiClient().getGenerativeModel({
    model: getGeminiModel(),
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 220,
      responseMimeType: "application/json",
    },
  });

  const result = await withRetry(
    () => model.generateContent([systemPrompt, prompt]),
    "Gemini JSON completion",
  );
  const response = await result.response;
  return response.text();
}

export async function getChatStream(
  prompt: string,
  context: string,
  history: ChatHistoryItem[] = [],
) {
  try {
    const provider = getAIProvider();
    if (provider === "deepseek") {
      return getDeepSeekStream(prompt, context, history);
    }

    const model = getGeminiClient().getGenerativeModel({
      model: getGeminiModel(),
    });

    const result = await withRetry(
      () =>
        model.generateContentStream([
          buildSystemPrompt(context, history, { streaming: true }),
          prompt,
        ]),
      "Gemini generateContentStream",
    );
    return result.stream as ChatStream;
  } catch (error) {
    console.error("AI Stream Error:", error);
    throw error;
  }
}
