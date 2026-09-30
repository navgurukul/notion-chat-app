import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

function ms(n: number) {
  return `${n.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`[${label}] took ${ms(performance.now() - start)}`);
  return result;
}

async function coldProbe() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await timed("index-scan probe", () =>
      client.query(`
        SELECT c.id
        FROM notion_chunks c
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> (SELECT embedding FROM notion_chunks WHERE embedding IS NOT NULL LIMIT 1)
        LIMIT 60
      `),
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function prewarm() {
  console.log("\nEnabling pg_prewarm extension (safe if already enabled)...");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_prewarm");

  console.log("\nPrewarming notion_chunks table + indexes...");
  await timed("pg_prewarm notion_chunks", () =>
    pool.query("SELECT pg_prewarm('notion_chunks')"),
  );
  await timed("pg_prewarm notion_chunks_embedding_idx", () =>
    pool.query("SELECT pg_prewarm('notion_chunks_embedding_idx')"),
  );
  await timed("pg_prewarm notion_chunks_fts_idx", () =>
    pool.query("SELECT pg_prewarm('notion_chunks_fts_idx')"),
  );
  await timed("pg_prewarm notion_pages", () =>
    pool.query("SELECT pg_prewarm('notion_pages')"),
  );
}

async function main() {
  try {
    console.log("=== BEFORE prewarm ===");
    await coldProbe();

    await prewarm();

    console.log("\n=== AFTER prewarm ===");
    await coldProbe();
  } catch (error) {
    console.error("[warm-cache] failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();