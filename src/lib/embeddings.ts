const BATCH_SIZE = 20;

export const EMBEDDING_DIMENSIONS = 768;
const DEFAULT_EMBEDDING_MODEL = "models/gemini-embedding-001";
const DEFAULT_EMBEDDING_API_VERSION = "v1beta";
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
let embeddingQuotaBlockedUntil = 0;

function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  return apiKey;
}

type EmbedResponse = {
  embedding?: {
    values?: number[];
  };
  error?: {
    message?: string;
  };
};

function getEmbeddingModel() {
  return (process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim();
}

function getEmbeddingApiVersion() {
  return (process.env.GEMINI_EMBEDDING_API_VERSION || DEFAULT_EMBEDDING_API_VERSION).trim();
}

function getQuotaCooldownMs() {
  const parsed = Number(process.env.GEMINI_EMBEDDING_QUOTA_COOLDOWN_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUOTA_COOLDOWN_MS;
}

function isQuotaError(message: string) {
  return /quota exceeded|rate-limit|rate limit|free_tier_requests/i.test(message);
}

async function callEmbeddingApi(text: string): Promise<number[] | null> {
  try {
    if (Date.now() < embeddingQuotaBlockedUntil) return null;

    const apiKey = getGeminiApiKey();
    const model = getEmbeddingModel();
    const version = getEmbeddingApiVersion();
    const endpoint = `https://generativelanguage.googleapis.com/${version}/${model}:embedContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        outputDimensionality: EMBEDDING_DIMENSIONS,
        content: {
          parts: [{ text }],
        },
      }),
    });

    const data = (await response.json()) as EmbedResponse;

    if (!response.ok) {
      throw new Error(data?.error?.message ?? `Embedding API error: ${response.status}`);
    }

    const values = data.embedding?.values;
    if (!values || values.length === 0) return null;
    if (values.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Invalid embedding dimension ${values.length}, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }

    return values;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) {
      embeddingQuotaBlockedUntil = Date.now() + getQuotaCooldownMs();
      if (process.env.NODE_ENV !== "production") {
        console.warn("Embedding quota exceeded; using full-text search until quota cooldown ends.");
      }
    } else {
      console.warn("Embedding generation failed (falling back to full-text search):", message);
    }
    return null;
  }
}

export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return callEmbeddingApi(trimmed);
}

export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((text) => embedText(text)));
    results.push(...embeddings);
  }

  return results;
}

type EmbeddingTextSource = {
  title?: string | null;
  owner?: string | null;
  created_by?: string | null;
  last_edited_by?: string | null;
  doc_type?: string | null;
  status?: string | null;
  content?: string | null;
};

export function buildEmbeddingText(page: EmbeddingTextSource): string {
  const parts = [
    page.title ? `Title: ${page.title}` : "",
    page.owner ? `Owner: ${page.owner}` : "",
    page.created_by ? `Created By: ${page.created_by}` : "",
    page.last_edited_by ? `Last Edited By: ${page.last_edited_by}` : "",
    page.doc_type ? `Type: ${page.doc_type}` : "",
    page.status ? `Status: ${page.status}` : "",
    page.content ? `Content:\n${page.content}` : "",
  ].filter(Boolean);

  return parts.join("\n");
}
