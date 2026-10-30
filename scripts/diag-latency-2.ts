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

async function listIndexes() {
  console.log("\n=== Indexes on notion_chunks ===");
  const result = await pool.query(`
    SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notion_chunks'
  `);
  console.table(result.rows);

  console.log("\n=== Index validity (indisvalid must be true to be used) ===");
  const validity = await pool.query(`
    SELECT
      i.relname AS index_name,
      idx.indisvalid,
      idx.indisready,
      idx.indislive
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    WHERE idx.indrelid = 'notion_chunks'::regclass
  `);
  console.table(validity.rows);
}

async function analyzeTable() {
  await timed("ANALYZE notion_chunks", () => pool.query("ANALYZE notion_chunks"));
}

async function compareSeqScanVsIndexScan() {
  const sql = `
    SELECT c.id
    FROM notion_chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> (SELECT embedding FROM notion_chunks WHERE embedding IS NOT NULL LIMIT 1)
    LIMIT 60
  `;

  console.log("\n=== Current planner choice (no hints) ===");
  const natural = await timed("natural plan", () => pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`));
  console.log(natural.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));

  console.log("\n=== Forcing index scan (enable_seqscan = off) ===");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const forced = await timed("forced index-scan plan", () =>
      client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`),
    );
    console.log(forced.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await listIndexes();
    await analyzeTable();
    await compareSeqScanVsIndexScan();
  } catch (error) {
    console.error("[diag-latency-2] failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();