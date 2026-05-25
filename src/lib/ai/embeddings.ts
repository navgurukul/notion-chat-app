const OPENAI_EMBEDDINGS_URL =
  "https://api.openai.com/v1/embeddings";

const DEFAULT_MODEL = "text-embedding-3-small";

const DEFAULT_BATCH_SIZE = 20;

const DEFAULT_MAX_RETRIES = 3;

const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);

export const EMBEDDING_DIMENSIONS = 1536;

/** OpenAI embedding models accept up to 8192 tokens per input. */
const DEFAULT_MAX_EMBEDDING_CHARS = 28_000;

export type EmbeddingTextSource = {
  title?: string | null;
  owner?: string | null;
  created_by?: string | null;
  last_edited_by?: string | null;
  doc_type?: string | null;
  status?: string | null;
  content?: string | null;
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let embeddingsDisabledReason: string | null = null;
let quotaWarningLogged = false;

function isQuotaError(error: unknown) {
  return error instanceof HttpError && error.status === 429;
}

/** Skip OpenAI embedding calls (sync still stores page text + FTS chunks). */
export function isEmbeddingsEnabled() {
  if (embeddingsDisabledReason) return false;

  if (process.env.EMBEDDINGS_ENABLED === "false") return false;
  if (process.env.EMBED === "false") return false;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return Boolean(apiKey);
}

function disableEmbeddings(reason: string) {
  if (embeddingsDisabledReason) return;
  embeddingsDisabledReason = reason;
  console.warn(`[embeddings] Disabled for this server run: ${reason}`);
}

function nullResults(count: number) {
  return Array.from({ length: count }, () => null);
}

function getOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  return apiKey;
}

function getEmbeddingModel() {
  return (
    process.env.OPENAI_EMBEDDING_MODEL ||
    DEFAULT_MODEL
  ).trim();
}

function getBatchSize() {
  const parsed = Number(
    process.env.OPENAI_EMBEDDING_BATCH_SIZE
  );

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BATCH_SIZE;
}

function getMaxRetries() {
  const parsed = Number(
    process.env.OPENAI_EMBEDDING_MAX_RETRIES
  );

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_RETRIES;
}

function getMaxEmbeddingChars() {
  const parsed = Number(process.env.OPENAI_EMBEDDING_MAX_CHARS);
  return Number.isFinite(parsed) && parsed > 1000
    ? Math.floor(parsed)
    : DEFAULT_MAX_EMBEDDING_CHARS;
}

/** Keep each embedding input under OpenAI's 8192-token limit. */
export function truncateForEmbedding(text: string) {
  const max = getMaxEmbeddingChars();
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function isTokenLimitError(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 400) return false;
  return /maximum input length|8192 tokens/i.test(error.message);
}

function isRetryableError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = (error as { status?: number }).status;

  // Quota/billing 429s won't succeed on retry — fail fast and disable further calls.
  if (status === 429) return false;

  return (
    typeof status === "number" &&
    RETRYABLE_STATUS_CODES.has(status)
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  label: string
): Promise<T> {
  const maxRetries = getMaxRetries();

  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (isQuotaError(error)) {
        disableEmbeddings("OpenAI quota exceeded");
        break;
      }

      if (!isRetryableError(error) || attempt === maxRetries) {
        break;
      }

      const delayMs = 500 * 2 ** (attempt - 1);

      if (process.env.NODE_ENV !== "production") {
        console.warn(`${label} failed. Retrying in ${delayMs}ms...`);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, delayMs)
      );
    }
  }

  throw lastError;
}

async function createHttpError(response: Response) {
  let message =
    response.statusText ||
    `HTTP ${response.status}`;

  try {
    const data = await response.json();

    if (typeof data?.error?.message === "string") {
      message = data.error.message;
    }
  } catch {
    // ignore json parse failure
  }

  return new HttpError(response.status, message);
}

async function requestEmbeddings(
  input: string | string[]
) {
  const response = await fetch(
    OPENAI_EMBEDDINGS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOpenAIKey()}`,
      },
      body: JSON.stringify({
        model: getEmbeddingModel(),
        input,
      }),
    }
  );

  if (!response.ok) {
    throw await createHttpError(response);
  }

  return response.json();
}

function validateEmbedding(
  embedding: unknown
): number[] | null {
  if (!Array.isArray(embedding)) {
    return null;
  }

  if (
    embedding.length !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Invalid embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, received ${embedding.length}`
    );
  }

  return embedding as number[];
}

function handleEmbeddingFailure(error: unknown, context: string) {
  if (isQuotaError(error)) {
    if (!quotaWarningLogged) {
      quotaWarningLogged = true;
      console.warn(
        `[embeddings] OpenAI quota exceeded during ${context}. Continuing without vectors (FTS search still works). Add billing or set EMBEDDINGS_ENABLED=false in .env.`,
      );
    }
    disableEmbeddings("OpenAI quota exceeded");
    return;
  }

  console.error(`[embeddings] ${context} failed:`, error);
}

export async function embedText(
  text: string
): Promise<number[] | null> {
  const trimmed = truncateForEmbedding(text);

  if (!trimmed) {
    return null;
  }

  if (!isEmbeddingsEnabled()) {
    return null;
  }

  try {
    const data = await withRetry(
      () => requestEmbeddings(trimmed),
      "OpenAI embedding request"
    );

    const embedding =
      data?.data?.[0]?.embedding;

    return validateEmbedding(embedding);
  } catch (error) {
    handleEmbeddingFailure(error, "embedText");
    return null;
  }
}

async function embedBatchSlice(batch: string[]) {
  const prepared = batch.map((text) => truncateForEmbedding(text));
  const nonEmpty = prepared.filter((text) => text.length > 0);

  if (!nonEmpty.length) {
    return batch.map(() => null);
  }

  try {
    const data = await requestEmbeddings(nonEmpty);
    const embeddings = data?.data ?? [];
    let embeddingIndex = 0;

    return batch.map((text) => {
      if (!truncateForEmbedding(text)) return null;
      const vector = validateEmbedding(embeddings[embeddingIndex]?.embedding);
      embeddingIndex += 1;
      return vector;
    });
  } catch (error) {
    if (!isTokenLimitError(error)) {
      throw error;
    }

    console.warn(
      "[embeddings] Batch hit token limit — embedding items one-by-one with truncation.",
    );

    const results: (number[] | null)[] = [];
    for (const text of batch) {
      const single = truncateForEmbedding(text);
      if (!single) {
        results.push(null);
        continue;
      }
      try {
        const data = await requestEmbeddings([single]);
        results.push(validateEmbedding(data?.data?.[0]?.embedding));
      } catch (singleError) {
        handleEmbeddingFailure(singleError, "embedBatch(item)");
        results.push(null);
      }
    }
    return results;
  }
}

export async function embedBatch(
  texts: string[]
): Promise<(number[] | null)[]> {
  if (!isEmbeddingsEnabled()) {
    return nullResults(texts.length);
  }

  const results: (number[] | null)[] = [];
  const batchSize = getBatchSize();

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    try {
      results.push(...(await embedBatchSlice(batch)));
    } catch (error) {
      handleEmbeddingFailure(error, "embedBatch");
      results.push(...nullResults(batch.length));
    }
  }

  return results;
}

export function buildEmbeddingText(
  page: EmbeddingTextSource
): string {
  const parts = [
    page.title
      ? `Title: ${page.title}`
      : "",

    page.owner
      ? `Owner: ${page.owner}`
      : "",

    page.created_by
      ? `Created By: ${page.created_by}`
      : "",

    page.last_edited_by
      ? `Last Edited By: ${page.last_edited_by}`
      : "",

    page.doc_type
      ? `Document Type: ${page.doc_type}`
      : "",

    page.status
      ? `Status: ${page.status}`
      : "",

    page.content
      ? `Content:\n${truncateForEmbedding(page.content)}`
      : "",
  ].filter(Boolean);

  return truncateForEmbedding(parts.join("\n"));
}