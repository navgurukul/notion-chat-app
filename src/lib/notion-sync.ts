/**
 * Notion → PostgreSQL Sync — Layer 3
 *
 * Reads all pages from the S3 JSON exports (already synced by existing scripts),
 * resolves metadata fields, generates embeddings, and upserts into notion_pages.
 *
 * Run via: POST /api/sync
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getPool, ensureSchema } from "./postgres";
import { embedBatch, buildEmbeddingText } from "./embeddings";

type RawNotionPage = {
  id?: string;
  title?: string;
  content?: string;
  url?: string;
  lastEdited?: string;
};

type ParsedPageData = {
  id: string;
  title: string | null;
  owner: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  type: string | null;
  status: string | null;
  stage: string | null;
  url: string | null;
  created_on: string | null;
  last_edited: string | null;
  content: string | null;
};

function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

async function readS3Object(s3: S3Client, bucket: string, key: string): Promise<string> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = obj.Body as { transformToString?: () => Promise<string> };
  if (typeof body?.transformToString === "function") {
    return body.transformToString();
  }
  return "";
}

function extractField(content: string, fieldName: string): string | null {
  // Prefer PROPERTIES section to avoid UUID values in METADATA section
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}:\\s*(.+)$`, "im");

  const propertiesBlock = content.match(/=== PROPERTIES ===([\s\S]*?)(?:===|$)/i)?.[1];
  if (propertiesBlock) {
    const match = propertiesBlock.match(regex);
    const value = match?.[1]?.trim();
    if (value && !/^[0-9a-f-]{36}$/i.test(value)) return value;
  }

  // Fallback: search full content, skip UUID-shaped values
  const allMatches = [...content.matchAll(new RegExp(`^${escaped}:\\s*(.+)$`, "gim"))];
  for (const match of allMatches) {
    const value = match?.[1]?.trim();
    if (value && !/^[0-9a-f-]{36}$/i.test(value)) return value;
  }

  return null;
}

function parsePageContent(raw: RawNotionPage): ParsedPageData {
  const content = raw.content ?? "";

  return {
    id: raw.id ?? "",
    title: raw.title ?? extractField(content, "DOCUMENT_TITLE") ?? null,
    owner: extractField(content, "Owner"),
    created_by: extractField(content, "Created by"),
    last_edited_by: extractField(content, "Last edited by"),
    type: extractField(content, "Type"),
    status: extractField(content, "Status"),
    stage: extractField(content, "Stage"),
    url: raw.url ?? extractField(content, "DOCUMENT_URL") ?? null,
    created_on: extractField(content, "Created on"),
    last_edited: extractField(content, "Last edited"),
    content,
  };
}

async function loadPagesFromS3(): Promise<ParsedPageData[]> {
  const bucket = process.env.S3_BUCKET_NAME;
  const prefix = process.env.S3_NOTION_PREFIX ?? "notion/pages/";

  if (!bucket) throw new Error("S3_BUCKET_NAME is missing");

  const s3 = getS3Client();
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith(".json")) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  console.log(`📂 Found ${keys.length} pages in S3`);

  // Fetch in parallel batches
  const BATCH = 50;
  const pages: ParsedPageData[] = [];

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const raws = await Promise.all(
      batch.map(async (key) => {
        try {
          const raw = await readS3Object(s3, bucket, key);
          return raw ? (JSON.parse(raw) as RawNotionPage) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const raw of raws) {
      if (raw?.id) pages.push(parsePageContent(raw));
    }
  }

  return pages;
}

async function upsertPages(pages: ParsedPageData[], embeddings: number[][]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const embedding = embeddings[i];
      const vectorLiteral = embedding?.length ? `[${embedding.join(",")}]` : null;

      await client.query(
        `INSERT INTO notion_pages
           (id, title, owner, created_by, last_edited_by, type, status, stage,
            url, created_on, last_edited, content, embedding, last_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,now())
         ON CONFLICT (id) DO UPDATE SET
           title          = EXCLUDED.title,
           owner          = EXCLUDED.owner,
           created_by     = EXCLUDED.created_by,
           last_edited_by = EXCLUDED.last_edited_by,
           type           = EXCLUDED.type,
           status         = EXCLUDED.status,
           stage          = EXCLUDED.stage,
           url            = EXCLUDED.url,
           created_on     = EXCLUDED.created_on,
           last_edited    = EXCLUDED.last_edited,
           content        = EXCLUDED.content,
           embedding      = EXCLUDED.embedding,
           last_synced    = now()`,
        [
          p.id, p.title, p.owner, p.created_by, p.last_edited_by,
          p.type, p.status, p.stage, p.url, p.created_on,
          p.last_edited, p.content, vectorLiteral,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type SyncResult = {
  total: number;
  synced: number;
  durationMs: number;
};

export async function syncNotionToPostgres(): Promise<SyncResult> {
  const start = Date.now();

  await ensureSchema();

  const pages = await loadPagesFromS3();
  if (pages.length === 0) {
    return { total: 0, synced: 0, durationMs: Date.now() - start };
  }

  // Try to generate embeddings — if the API key doesn't support it, skip and use full-text search
  let embeddings: number[][] = new Array(pages.length).fill([]);
  try {
    console.log(`🔢 Generating embeddings for ${pages.length} pages...`);
    const embeddingTexts = pages.map((p) =>
      buildEmbeddingText({
        title: p.title ?? undefined,
        owner: p.owner ?? undefined,
        created_by: p.created_by ?? undefined,
        type: p.type ?? undefined,
        status: p.status ?? undefined,
        content: p.content ?? undefined,
      }),
    );
    embeddings = await embedBatch(embeddingTexts);
    console.log(`✅ Embeddings generated`);
  } catch (err) {
    console.warn(`⚠️ Embedding generation failed — syncing metadata only (semantic search will use full-text fallback):`, err instanceof Error ? err.message : err);
    embeddings = new Array(pages.length).fill([]);
  }

  console.log(`💾 Upserting ${pages.length} pages into PostgreSQL...`);
  await upsertPages(pages, embeddings);

  const durationMs = Date.now() - start;
  console.log(`✅ Sync complete: ${pages.length} pages in ${(durationMs / 1000).toFixed(1)}s`);

  return { total: pages.length, synced: pages.length, durationMs };
}
