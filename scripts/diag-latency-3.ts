import "dotenv/config";
import { embedText } from "../src/lib/ai/embeddings";
import { pool } from "../src/lib/db/postgres";

const SAMPLE_QUESTION = "how does the sync feature work?";

const FULL_HYBRID_SQL = `
  WITH sem AS (
    SELECT
      c.id,
      1 - (c.embedding <=> $1::vector) AS sem_score
    FROM notion_chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector ASC
    LIMIT $3
  ),
  kw AS (
    SELECT
      c.id,
      LEAST(1.0, ts_rank_cd(c.fts, plainto_tsquery('english', $2)))::float8 AS kw_score
    FROM notion_chunks c
    WHERE c.fts @@ plainto_tsquery('english', $2)
    ORDER BY kw_score DESC NULLS LAST
    LIMIT $3
  ),
  ids AS (
    SELECT id FROM sem
    UNION
    SELECT id FROM kw
  )
  SELECT
    c.id AS chunk_id,
    c.page_id,
    p.title,
    COALESCE(sem.sem_score, 0)::float8 AS sem_score,
    COALESCE(kw.kw_score, 0)::float8 AS kw_score,
    (
      (0.6 * COALESCE(sem.sem_score, 0) + 0.4 * COALESCE(kw.kw_score, 0)) / 1
    )::float8 AS final_score
  FROM ids
  JOIN notion_chunks c ON c.id = ids.id
  JOIN notion_pages p ON p.id = c.page_id
  LEFT JOIN sem ON sem.id = c.id
  LEFT JOIN kw ON kw.id = c.id
  ORDER BY final_score DESC NULLS LAST, c.page_id, c.chunk_index
  LIMIT $3
`;

function ms(n: number) {
  return `${n.toFixed(0)}ms`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`\n[${label}] took ${ms(performance.now() - start)}`);
  return result;
}

async function main() {
  console.log(`Embedding sample question: "${SAMPLE_QUESTION}"`);
  const embedding = await timed("embedText", () => embedText(SAMPLE_QUESTION));
  if (!embedding) {
    console.error("embedText returned null — check OPENAI_API_KEY / embeddings enabled.");
    process.exit(1);
  }
  const vectorLiteral = `[${embedding.join(",")}]`;
  const params = [vectorLiteral, SAMPLE_QUESTION, 80];

  console.log("\n=== Natural plan (no hints, plain query()) ===");
  const natural = await timed("natural full-query plan", () =>
    pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${FULL_HYBRID_SQL}`, params),
  );
  console.log(natural.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));

  console.log("\n=== Forced index scan (SET LOCAL enable_seqscan = off) ===");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const forced = await timed("forced full-query plan", () =>
      client.query(`EXPLAIN (ANALYZE, BUFFERS) ${FULL_HYBRID_SQL}`, params),
    );
    console.log(forced.rows.map((r: any) => r["QUERY PLAN"]).join("\n"));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[diag-latency-3] failed:", err);
  process.exit(1);
});