// Use REST API directly — the @google/generative-ai SDK defaults to v1beta
// which does not support embedding models. The stable v1 endpoint does.
const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 20;
const BASE_URL = "https://generativelanguage.googleapis.com/v1/models";

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is required for embeddings");
  return key;
}

async function embedSingle(text: string): Promise<number[]> {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    embedding?: { values?: number[] };
  };

  const values = data?.embedding?.values;
  if (!values?.length) throw new Error("Empty embedding returned from API");
  return values;
}

export async function embedText(text: string): Promise<number[]> {
  return embedSingle(text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map((text) => embedSingle(text)));
    embeddings.push(...results);

    if (process.env.NODE_ENV !== "production") {
      console.log(`Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length} pages`);
    }

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return embeddings;
}

export { EMBEDDING_DIMENSIONS };

// Prepare text for embedding: combine title + key metadata + content preview
export function buildEmbeddingText(page: {
  title?: string;
  owner?: string;
  created_by?: string;
  type?: string;
  status?: string;
  content?: string;
}): string {
  const parts: string[] = [];

  if (page.title) parts.push(`Title: ${page.title}`);
  if (page.owner) parts.push(`Owner: ${page.owner}`);
  if (page.created_by) parts.push(`Created by: ${page.created_by}`);
  if (page.type) parts.push(`Type: ${page.type}`);
  if (page.status) parts.push(`Status: ${page.status}`);

  if (page.content) {
    parts.push(page.content.slice(0, 6000));
  }

  return parts.join("\n");
}
