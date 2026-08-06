/**
 * Backfill embeddings for pages/chunks that are NULL or marked failed/pending.
 * Does not call Notion — only fills vectors in Postgres.
 *
 * Usage:
 *   npm run embed:missing
 *   EMBED_BATCH_LIMIT=50 npm run embed:missing
 *   EMBED_TARGET=chunks,pages npm run embed:missing
 */
import "dotenv/config";
import { buildEmbeddingText, embedBatch, isEmbeddingsEnabled } from "../src/lib/ai/embeddings";
import { query } from "../src/lib/db";
import { EMBEDDING_STATUS } from "../src/lib/ingestion/sync-status";

const CHUNK_BATCH = 20;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toVectorLiteral(values: number[] | null) {
  if (!values) return null;
  return `[${values.join(",")}]`;
}

function readLimit() {
  const parsed = Number.parseInt(process.env.EMBED_BATCH_LIMIT ?? "50", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function readDelayMs() {
  const parsed = Number.parseInt(process.env.EMBED_BATCH_DELAY_MS ?? "1500", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1500;
}

function readTargets() {
  const raw = (process.env.EMBED_TARGET ?? "chunks,pages").toLowerCase();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function embedMissingChunks(limit: number, delayMs: number) {
  const rows = await query<{ id: string; content: string; page_id: string }>(
    `
    SELECT c.id, c.content, c.page_id
    FROM notion_chunks c
    JOIN notion_pages p ON p.id = c.page_id
    WHERE c.embedding IS NULL
      AND p.embedding_status IN ('pending', 'failed', 'processing')
    ORDER BY
      CASE p.embedding_status WHEN 'failed' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
      c.page_id,
      c.chunk_index
    LIMIT $1
    `,
    [limit],
  );

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_BATCH) {
    const batch = rows.slice(i, i + CHUNK_BATCH);
    const embeddings = await embedBatch(batch.map((row) => row.content));

    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j];
      const embedding = embeddings[j];
      if (!embedding) {
        failed += 1;
        continue;
      }
      await query(
        `UPDATE notion_chunks SET embedding = CAST($1 AS vector) WHERE id = $2`,
        [toVectorLiteral(embedding), row.id],
      );
      embedded += 1;
    }

    if (i + CHUNK_BATCH < rows.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const remaining = await query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM notion_chunks c
    JOIN notion_pages p ON p.id = c.page_id
    WHERE c.embedding IS NULL
      AND p.embedding_status IN ('pending', 'failed', 'processing')
    `,
  );

  return {
    selected: rows.length,
    embedded,
    failed,
    remaining_null: Number(remaining[0]?.count ?? 0),
  };
}

async function embedMissingPages(limit: number, delayMs: number) {
  const rows = await query<{
    id: string;
    title: string | null;
    content: string | null;
    owner: string | null;
    created_by: string | null;
    last_edited_by: string | null;
    doc_type: string | null;
    status: string | null;
  }>(
    `
    SELECT id, title, content, owner, created_by, last_edited_by, doc_type, status
    FROM notion_pages
    WHERE embedding IS NULL
      AND embedding_status IN ('pending', 'failed', 'processing')
    ORDER BY
      CASE embedding_status WHEN 'failed' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
      synced_at DESC NULLS LAST
    LIMIT $1
    `,
    [limit],
  );

  let embedded = 0;
  let failed = 0;
  let skipped_empty = 0;

  for (let i = 0; i < rows.length; i += CHUNK_BATCH) {
    const batch = rows.slice(i, i + CHUNK_BATCH);
    const texts = batch.map((row) =>
      buildEmbeddingText({
        title: row.title,
        owner: row.owner,
        created_by: row.created_by,
        last_edited_by: row.last_edited_by,
        doc_type: row.doc_type,
        status: row.status,
        content: row.content?.slice(0, 12000) ?? "",
      }).trim(),
    );
    const embeddings = await embedBatch(texts);

    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j];
      const embedding = embeddings[j];
      const embedInput = texts[j];
      if (!embedInput) {
        skipped_empty += 1;
        await query(
          `
          UPDATE notion_pages
          SET embedding_status = $2, last_error = $3
          WHERE id = $1
          `,
          [row.id, EMBEDDING_STATUS.failed, "No text to embed (empty page)"],
        );
        continue;
      }
      if (!embedding) {
        failed += 1;
        await query(
          `
          UPDATE notion_pages
          SET embedding_status = $2, last_error = $3
          WHERE id = $1
          `,
          [row.id, EMBEDDING_STATUS.failed, "Page embedding backfill failed"],
        );
        continue;
      }
      await query(
        `
        UPDATE notion_pages
        SET embedding = CAST($1 AS vector), embedding_status = $3, last_error = NULL
        WHERE id = $2
        `,
        [toVectorLiteral(embedding), row.id, EMBEDDING_STATUS.completed],
      );
      embedded += 1;
    }

    if (i + CHUNK_BATCH < rows.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const remaining = await query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM notion_pages
    WHERE embedding IS NULL
      AND embedding_status IN ('pending', 'failed', 'processing')
    `,
  );

  return {
    selected: rows.length,
    embedded,
    failed,
    skipped_empty,
    remaining_null: Number(remaining[0]?.count ?? 0),
  };
}

async function main() {
  if (!isEmbeddingsEnabled()) {
    console.error(
      "[embed-missing] Embeddings disabled. Set OPENAI_API_KEY and EMBEDDINGS_ENABLED=true in .env",
    );
    process.exit(1);
  }

  const limit = readLimit();
  const delayMs = readDelayMs();
  const targets = readTargets();

  console.log(
    `[embed-missing] limit=${limit} delay_ms=${delayMs} targets=${[...targets].join(",")}`,
  );

  const result: Record<string, unknown> = {};

  if (targets.has("chunks")) {
    result.chunks = await embedMissingChunks(limit, delayMs);
  }
  if (targets.has("pages")) {
    result.pages = await embedMissingPages(limit, delayMs);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
