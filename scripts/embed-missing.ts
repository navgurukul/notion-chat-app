/**
 * Backfill embeddings for chunks (and optionally pages) that are NULL.
 * Use small limits to avoid Gemini quota spikes during full sync.
 *
 * Usage:
 *   npx tsx scripts/embed-missing.ts
 *   EMBED_BATCH_LIMIT=50 npx tsx scripts/embed-missing.ts
 *   EMBED_BATCH_LIMIT=50 EMBED_TARGET=chunks,pages npx tsx scripts/embed-missing.ts
 */
import "dotenv/config";
import { embedBatch } from "../src/lib/embeddings";
import { query } from "../src/lib/postgres";

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
  const raw = (process.env.EMBED_TARGET ?? "chunks").toLowerCase();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function embedMissingChunks(limit: number, delayMs: number) {
  const rows = await query<{ id: string; content: string }>(
    `
    SELECT id, content
    FROM notion_chunks
    WHERE embedding IS NULL
    ORDER BY page_id, chunk_index
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
    `SELECT COUNT(*)::text AS count FROM notion_chunks WHERE embedding IS NULL`,
  );

  return {
    selected: rows.length,
    embedded,
    failed,
    remaining_null: Number(remaining[0]?.count ?? 0),
  };
}

async function embedMissingPages(limit: number, delayMs: number) {
  const rows = await query<{ id: string; content: string; title: string | null }>(
    `
    SELECT id, title, content
    FROM notion_pages
    WHERE embedding IS NULL
    ORDER BY synced_at DESC NULLS LAST
    LIMIT $1
    `,
    [limit],
  );

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_BATCH) {
    const batch = rows.slice(i, i + CHUNK_BATCH);
    const embeddings = await embedBatch(batch.map((row) => row.content.slice(0, 12000)));

    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j];
      const embedding = embeddings[j];
      if (!embedding) {
        failed += 1;
        continue;
      }
      await query(
        `UPDATE notion_pages SET embedding = CAST($1 AS vector) WHERE id = $2`,
        [toVectorLiteral(embedding), row.id],
      );
      embedded += 1;
    }

    if (i + CHUNK_BATCH < rows.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const remaining = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notion_pages WHERE embedding IS NULL`,
  );

  return {
    selected: rows.length,
    embedded,
    failed,
    remaining_null: Number(remaining[0]?.count ?? 0),
  };
}

async function main() {
  const limit = readLimit();
  const delayMs = readDelayMs();
  const targets = readTargets();

  console.log(`[embed-missing] limit=${limit} delay_ms=${delayMs} targets=${[...targets].join(",")}`);

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
