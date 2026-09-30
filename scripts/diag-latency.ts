import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

function ms(n: number) {
  return `${n.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  console.log(`\n[${label}] took ${ms(elapsed)}`);
  return result;
}

async function explain(label: string, sql: string, params: unknown[] = []) {
  const result = await timed(label, () => pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params));
  console.log(result.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));
  return result;
}

async function tableSizes() {
  const result = await timed("table sizes", () =>
    pool.query(`
      SELECT
        (SELECT count(*) FROM notion_pages) AS pages,
        (SELECT count(*) FROM notion_chunks) AS chunks,
        pg_size_pretty(pg_total_relation_size('notion_chunks')) AS chunks_size,
        pg_size_pretty(pg_total_relation_size('notion_pages')) AS pages_size
    `),
  );
  console.table(result.rows);
}

async function connectionLatencyProbe() {
  console.log("\n=== Connection / cold-start probe ===");
  console.log("Running SELECT 1 three times in a row (same pool):");
  for (let i = 1; i <= 3; i++) {
    await timed(`SELECT 1 (call ${i})`, () => pool.query("SELECT 1"));
  }

  console.log("\nWaiting 12s (past default pool idleTimeoutMillis) to see if the next call pays a reconnect cost...");
  await new Promise((r) => setTimeout(r, 12_000));
  await timed("SELECT 1 (after 12s idle)", () => pool.query("SELECT 1"));
}

async function vectorIndexCheck() {
  console.log("\n=== 1. Is the HNSW vector index being used? ===");
  await explain(
    "vector search EXPLAIN",
    `
    SELECT c.id
    FROM notion_chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> (SELECT embedding FROM notion_chunks WHERE embedding IS NOT NULL LIMIT 1)
    LIMIT 60
    `,
  );
}

async function ftsIndexCheck() {
  console.log("\n=== 2. Is the notion_pages FTS index being used? ===");
  await explain(
    "fts search EXPLAIN",
    `SELECT id FROM notion_pages WHERE fts @@ plainto_tsquery('simple', $1)`,
    ["notion rag chatbot"],
  );
}

async function main() {
  try {
    console.log("=== 3. Table sizes ===");
    await tableSizes();

    await vectorIndexCheck();
    await ftsIndexCheck();
    await connectionLatencyProbe();
  } catch (error) {
    console.error("[diag-latency] failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();