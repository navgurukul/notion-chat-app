import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

async function testFTS() {
  const queryText = "leave policy navgurukul";
  
  console.log("=== Testing FTS Queries ===");
  
  // 1. Current strict english query
  const resStrictEnglish = await pool.query(
    `SELECT count(*)::int AS count FROM notion_chunks WHERE fts @@ plainto_tsquery('english', $1)`,
    [queryText]
  );
  console.log("Strict English FTS matches:", resStrictEnglish.rows[0].count);

  // 2. Strict simple query
  const resStrictSimple = await pool.query(
    `SELECT count(*)::int AS count FROM notion_chunks WHERE fts @@ plainto_tsquery('simple', $1)`,
    [queryText]
  );
  console.log("Strict Simple FTS matches:", resStrictSimple.rows[0].count);

  // 3. Soft simple OR query
  const words = queryText.split(/\s+/).map(w => w.trim()).filter(Boolean);
  const placeholders = words.map((_, i) => `plainto_tsquery('simple', $${i + 1})`).join(" || ");
  const queryStr = `SELECT count(*)::int AS count FROM notion_chunks WHERE fts @@ (${placeholders})`;
  
  const resSoftSimple = await pool.query(queryStr, words);
  console.log("Soft Simple (OR) FTS matches:", resSoftSimple.rows[0].count);
  
  // Let's print a few match samples for the soft simple query
  const samplesQuery = `
    SELECT c.content, ts_rank_cd(c.fts, (${placeholders})) AS rank
    FROM notion_chunks c
    WHERE c.fts @@ (${placeholders})
    ORDER BY rank DESC
    LIMIT 3
  `;
  const samples = await pool.query(samplesQuery, words);
  console.log("\nTop matches for Soft Simple FTS:");
  for (const row of samples.rows) {
    console.log(`- Rank: ${row.rank}\n  Content: ${row.content.substring(0, 150)}...\n`);
  }

  await pool.end();
}

testFTS().catch(console.error);
