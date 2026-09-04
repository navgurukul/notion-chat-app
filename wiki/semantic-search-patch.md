# HNSW ef_search tuning — apply to src/lib/rag/semantic-search.ts

## What and why

HNSW index build quality is set by `ef_construction=64` (in postgres.ts).
But query-time recall is controlled separately by `hnsw.ef_search`.

Default in pgvector: `hnsw.ef_search = 40`
Your top-K fetch:    `VECTOR_SEARCH_TOP_K=30`

Rule: ef_search should be >= top_k you're fetching.
Recommended: `ef_search = 100` gives good recall with minimal latency cost.

## Where to add it

In `src/lib/rag/semantic-search.ts`, wherever you run the vector similarity query,
wrap it in a transaction with SET LOCAL so it only affects that query:

```ts
// BEFORE (current pattern, approximately):
const results = await query<...>(`
  SELECT page_id, content, 1 - (embedding <=> $1::vector) AS score
  FROM notion_chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT $2
`, [vectorLiteral, topK]);


// AFTER — add SET LOCAL before the search query using a dedicated client:
const client = await pool.connect();
try {
  // SET LOCAL only applies for this transaction — no global side effects
  await client.query("BEGIN");
  await client.query("SET LOCAL hnsw.ef_search = 100");

  const result = await client.query<...>(`
    SELECT page_id, content, 1 - (embedding <=> $1::vector) AS score
    FROM notion_chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [vectorLiteral, topK]);

  await client.query("COMMIT");
  return result.rows;
} finally {
  client.release();
}
```

## Verify HNSW is actually being used

Run this in your DB:
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'notion_chunks';
```

You should see: `USING hnsw` — not `ivfflat`.

Also verify with EXPLAIN:
```sql
EXPLAIN SELECT page_id, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS score
FROM notion_chunks
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 30;
```

Look for `Index Scan using notion_chunks_embedding_idx` in the output.