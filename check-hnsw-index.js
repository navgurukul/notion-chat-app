// Standalone diagnostic — checks whether the HNSW vector index on
// notion_chunks is actually being used by the hybrid search query, and
// reports basic table/index stats. Doesn't touch your app code.
//
// Run locally (from the notion-chat-app project root, where `pg` is
// already installed):
//
//   node check-hnsw-index.js
//
// It reads DATABASE_URL from your existing .env file.

require("dotenv").config();
const dns = require("dns");
const { Pool } = require("pg");

// Same DNS workaround your app already uses (src/lib/dns-hook.ts) — without
// it, this script hits the same EAI_AGAIN DNS failure the app was patched
// for, since this network's default DNS resolution to neon.tech is
// unreliable.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
const originalLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  if (hostname && (hostname.includes("neon.tech") || hostname.includes("openai.com"))) {
    const dnsStart = Date.now();
    dns.resolve4(hostname, (err, addrs) => {
      console.log(`[dns] resolve4(${hostname}) took ${Date.now() - dnsStart}ms`, err ? `ERROR: ${err.message}` : `-> ${addrs?.[0]}`);
      if (!err && addrs && addrs.length > 0) {
        if (options.all) return callback(null, addrs.map((a) => ({ address: a, family: 4 })));
        return callback(null, addrs[0], 4);
      }
      return originalLookup(hostname, options, callback);
    });
    return;
  }
  return originalLookup(hostname, options, callback);
};

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log("\n=== 0. Raw connection time (DNS + TCP + TLS + auth) ===");
  const connStart = Date.now();
  const client = await pool.connect();
  console.log(`First connection established in ${Date.now() - connStart}ms`);
  client.release();

  const conn2Start = Date.now();
  const client2 = await pool.connect();
  console.log(`Second connection (pool reuse) established in ${Date.now() - conn2Start}ms`);
  client2.release();

  console.log("\n=== 1. Do the indexes exist? ===");
  const indexes = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'notion_chunks'
    ORDER BY indexname;
  `);
  console.table(indexes.rows);

  console.log("\n=== 2. Table size & row count ===");
  const stats = await pool.query(`
    SELECT
      (SELECT count(*) FROM notion_chunks) AS chunk_count,
      (SELECT count(*) FROM notion_chunks WHERE embedding IS NOT NULL) AS embedded_count,
      pg_size_pretty(pg_total_relation_size('notion_chunks')) AS table_size;
  `);
  console.table(stats.rows);

  console.log("\n=== 3. EXPLAIN ANALYZE on the actual vector search shape ===");
  // Fake embedding vector (1536 dims of 0.001) — good enough to test the
  // query PLAN (Index Scan vs Seq Scan), not the actual match quality.
  const fakeVector = `[${Array(1536).fill(0.001).join(",")}]`;
  const explain = await pool.query(
    `
    EXPLAIN ANALYZE
    SELECT c.id, 1 - (c.embedding <=> $1::vector) AS sem_score
    FROM notion_chunks c
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1::vector ASC
    LIMIT 80;
  `,
    [fakeVector]
  );
  explain.rows.forEach((r) => console.log(r["QUERY PLAN"]));

  console.log("\n=== 4. Current Neon compute info (if available) ===");
  try {
    const version = await pool.query("SELECT version();");
    console.log(version.rows[0].version);
  } catch (e) {
    console.log("(couldn't fetch version)", e.message);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});