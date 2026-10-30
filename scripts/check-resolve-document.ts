import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

const LIKE_PATTERN = "%Notion RAG chatbot%";

function ms(n: number) {
  return `${n.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`[${label}] took ${ms(performance.now() - start)}`);
  return result;
}

async function main() {
  console.log("=== Natural plan (no hints) ===");
  const natural = await timed("natural plan", () =>
    pool.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT title, url FROM notion_pages
       WHERE title IS NOT NULL AND trim(title) <> ''
         AND title ILIKE $1
       LIMIT 100`,
      [LIKE_PATTERN],
    ),
  );
  console.log(natural.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));

  console.log("\n=== Forced index scan (SET LOCAL enable_seqscan = off) ===");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const forced = await timed("forced plan", () =>
      client.query(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT title, url FROM notion_pages
         WHERE title IS NOT NULL AND trim(title) <> ''
           AND title ILIKE $1
         LIMIT 100`,
        [LIKE_PATTERN],
      ),
    );
    console.log(forced.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[check-resolve-document] failed:", err);
  process.exit(1);
});