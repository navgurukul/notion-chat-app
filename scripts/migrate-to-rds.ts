#!/usr/bin/env tsx
/**
 * ============================================================
 *  migrate-to-rds.ts  —  Neon → AWS RDS PostgreSQL
 * ============================================================
 *
 *  Source : Neon PostgreSQL  (DATABASE_URL / SOURCE_DATABASE_URL)
 *  Target : AWS RDS Postgres (RDS_DATABASE_URL)
 *
 *  Usage (run from project root):
 *    npx tsx scripts/migrate-to-rds.ts            ← full migration
 *    npx tsx scripts/migrate-to-rds.ts --dry-run  ← just check connections + row counts
 *    npx tsx scripts/migrate-to-rds.ts --clean    ← wipe RDS then copy
 *    npm run migrate:rds                           ← same as first line
 * ============================================================
 */

import * as dns  from "dns";
import * as fs   from "fs";
import * as path from "path";
import { Pool, type PoolClient } from "pg";

// ─── Load .env manually (no dotenv dep needed) ─────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}
loadEnv();

// ─── Fix DNS: force IPv4 via Google DNS for AWS + Neon hosts ───────────────
// Custom lookup: force IPv4 via Google DNS (8.8.8.8) for Neon + RDS hostnames.
// This bypasses slow / broken system DNS in sandboxed environments.
// Passed directly into the pg Pool config as `lookup`.
function customLookup(hostname: string, opts: any, cb: any) {
  if (hostname && (
    hostname.includes("neon.tech") ||
    hostname.includes("rds.amazonaws.com")
  )) {
    dns.resolve4(hostname, (err, addrs) => {
      if (!err && addrs?.length) {
        return opts?.all
          ? cb(null, addrs.map((a: string) => ({ address: a, family: 4 })))
          : cb(null, addrs[0], 4);
      }
      // Fallback to system DNS if resolve4 fails
      dns.lookup(hostname, opts, cb);
    });
    return;
  }
  dns.lookup(hostname, opts, cb);
}

// ─── Connection URLs ────────────────────────────────────────────────────────
//
//  SOURCE  =  your Neon database (current production data)
//  TARGET  =  your AWS RDS database (migration destination)
//
const RAW_SOURCE =
  process.env.SOURCE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "";

const RAW_TARGET =
  process.env.RDS_DATABASE_URL ||
  process.env.TARGET_DATABASE_URL ||
  "";

// ─── URL cleaner ────────────────────────────────────────────────────────────
function cleanUrl(raw: string): string {
  let u = raw.trim();
  // node-postgres doesn't understand channel_binding — strip it
  u = u.replace(/[&?]channel_binding=[^&?]*/g, "");
  // Let the explicit pool SSL config control certificate verification.
  u = u.replace(/[?&]sslmode=[^&]*/g, "");
  u = u.replace(/\?&/, "?");
  // clean up any trailing ? or & left over
  u = u.replace(/[?&]$/, "");
  return u;
}

// ─── Create Pool ────────────────────────────────────────────────────────────
function makePool(rawUrl: string): Pool {
  const url = cleanUrl(rawUrl);
  const needSsl =
    rawUrl.includes("neon.tech") ||
    rawUrl.includes("rds.amazonaws.com") ||
    rawUrl.includes("sslmode=");

  const cfg: any = {
    connectionString: url,
    lookup: dns.lookup,
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
  };
  return new Pool(cfg);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function maskUrl(raw: string): string {
  try {
    const p = new URL(raw);
    p.password = "****";
    return p.toString();
  } catch { return "[unparseable-url]"; }
}

async function tableExists(client: PoolClient, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [name]
  );
  return r.rows.length > 0;
}

async function rowCount(client: PoolClient, table: string): Promise<number> {
  const r = await client.query<{c: string}>(`SELECT COUNT(*)::text AS c FROM "${table}"`);
  return parseInt(r.rows[0].c, 10);
}

// Returns column names for INSERT (excludes generated/computed columns)
async function insertableColumns(client: PoolClient, table: string): Promise<string[]> {
  const r = await client.query<{ col: string }>(
    `SELECT column_name AS col
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND is_generated = 'NEVER'      -- skip GENERATED ALWAYS columns (fts etc.)
       AND column_name != 'fts'        -- extra safety: always skip fts
     ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map(r => r.col);
}

// ─── Schema DDL on target ───────────────────────────────────────────────────
async function createSchema(client: PoolClient) {
  console.log("   Creating extensions...");
  // vector extension — needs pgvector installed on RDS (Postgres 15.2+)
  await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
  await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  console.log("   ✅ Extensions: vector, pgcrypto, pg_trgm");

  console.log("   Creating tables...");

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT        UNIQUE NOT NULL,
      name          TEXT,
      image_url     TEXT,
      provider      TEXT        DEFAULT 'google',
      last_login_at TIMESTAMP,
      updated_at    TIMESTAMP   DEFAULT NOW(),
      created_at    TIMESTAMP   DEFAULT NOW()
    );`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id         UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID   REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT   DEFAULT 'New Chat',
      state      JSONB  DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID  REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role       TEXT  NOT NULL,
      content    TEXT  NOT NULL,
      emotion    TEXT,
      feedback   TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx      ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages(session_id, created_at DESC);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS notion_pages (
      id               TEXT PRIMARY KEY,
      title            TEXT,
      url              TEXT,
      owner            TEXT,
      created_by       TEXT,
      last_edited_by   TEXT,
      doc_type         TEXT,
      status           TEXT,
      due_date         TEXT,
      content          TEXT,
      embedding        vector(1536),
      synced_at        TIMESTAMP DEFAULT NOW(),
      notion_edited_at TIMESTAMP,
      embedding_status TEXT DEFAULT 'pending',
      last_error       TEXT
    );`);

  // fts column (generated — added separately so we can check existence first)
  const hasFtsPages = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notion_pages' AND column_name='fts' LIMIT 1`
  );
  if (!hasFtsPages.rows.length) {
    await client.query(`
      ALTER TABLE notion_pages
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
      ) STORED;`);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS notion_pages_embedding_status_idx ON notion_pages(embedding_status);
    CREATE INDEX IF NOT EXISTS notion_pages_edited_idx           ON notion_pages(notion_edited_at);
    CREATE INDEX IF NOT EXISTS notion_pages_synced_at_idx        ON notion_pages(synced_at);
    CREATE INDEX IF NOT EXISTS notion_pages_fts_idx              ON notion_pages USING gin(fts);
    CREATE INDEX IF NOT EXISTS notion_pages_title_trgm_idx       ON notion_pages USING gin(title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS notion_pages_content_trgm_idx     ON notion_pages USING gin(content gin_trgm_ops);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS notion_chunks (
      id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id         TEXT    NOT NULL REFERENCES notion_pages(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      section_heading TEXT,
      heading_path    TEXT,
      content         TEXT    NOT NULL,
      char_count      INTEGER NOT NULL DEFAULT 0,
      token_count     INTEGER NOT NULL DEFAULT 0,
      embedding       vector(1536),
      UNIQUE (page_id, chunk_index)
    );`);

  const hasFtsChunks = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notion_chunks' AND column_name='fts' LIMIT 1`
  );
  if (!hasFtsChunks.rows.length) {
    await client.query(`
      ALTER TABLE notion_chunks
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(content,''))
      ) STORED;`);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS notion_chunks_embedding_idx ON notion_chunks
      USING hnsw(embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
    CREATE INDEX IF NOT EXISTS notion_chunks_fts_idx          ON notion_chunks USING gin(fts);
    CREATE INDEX IF NOT EXISTS notion_chunks_content_trgm_idx ON notion_chunks USING gin(content gin_trgm_ops);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS name_genders (
      name       TEXT PRIMARY KEY,
      gender     TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sync_metadata (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );`);

  console.log("   ✅ All tables and indexes created on RDS");
}

// ─── Copy one table ─────────────────────────────────────────────────────────
async function copyTable(
  src: Pool,
  tgt: Pool,
  tableName: string,
  pkCols: string[],
  orderBy: string,
  batchSize = 300,
): Promise<{ copied: number }> {
  const srcClient = await src.connect();
  const tgtClient = await tgt.connect();
  try {
    // check table exists in source
    if (!(await tableExists(srcClient, tableName))) {
      console.log(`   ⏭  '${tableName}' not found in source — skipped`);
      return { copied: 0 };
    }

    const total = await rowCount(srcClient, tableName);
    if (total === 0) {
      console.log(`   ⬜ '${tableName}' is empty — nothing to copy`);
      return { copied: 0 };
    }

    // columns we can INSERT (no generated cols)
    const cols = await insertableColumns(srcClient, tableName);
    const quotedCols = cols.map(c => `"${c}"`).join(", ");
    const pkList      = pkCols.map(c => `"${c}"`).join(", ");

    // ON CONFLICT update all non-PK columns
    const updateCols  = cols.filter(c => !pkCols.includes(c));
    const conflictSQL = updateCols.length
      ? `ON CONFLICT (${pkList}) DO UPDATE SET ${updateCols.map(c => `"${c}"=EXCLUDED."${c}"`).join(", ")}`
      : `ON CONFLICT (${pkList}) DO NOTHING`;

    let offset = 0;
    let copied = 0;

    while (offset < total) {
      // Fetch batch from source
      const res = await srcClient.query(
        `SELECT ${quotedCols} FROM "${tableName}" ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      const rows = res.rows;
      if (!rows.length) break;

      // Build multi-row INSERT
      const values: any[]   = [];
      const rowParts: string[] = [];
      let   paramIdx = 1;

      for (const row of rows) {
        const placeholders: string[] = [];
        for (const col of cols) {
          let val = row[col];

          // pgvector: convert array or string to vector literal
          if (col === "embedding") {
            if (Array.isArray(val)) val = `[${val.join(",")}]`;
            else if (val !== null && val !== undefined) val = String(val);
            placeholders.push(`$${paramIdx}::vector`);
          }
          // JSONB
          else if (col === "state") {
            if (val !== null && typeof val === "object") val = JSON.stringify(val);
            placeholders.push(`$${paramIdx}::jsonb`);
          }
          else {
            placeholders.push(`$${paramIdx}`);
          }

          values.push(val ?? null);
          paramIdx++;
        }
        rowParts.push(`(${placeholders.join(", ")})`);
      }

      const sql = `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${rowParts.join(", ")} ${conflictSQL}`;
      await tgtClient.query(sql, values);

      copied  += rows.length;
      offset  += rows.length;

      const pct = Math.round((copied / total) * 100);
      process.stdout.write(`\r   '${tableName}': ${copied}/${total} rows (${pct}%)   `);
    }

    process.stdout.write("\n");
    return { copied };
  } finally {
    srcClient.release();
    tgtClient.release();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const isClean  = process.argv.includes("--clean");
  const isHelp   = process.argv.includes("--help") || process.argv.includes("-h");

  if (isHelp) {
    console.log(`
Neon → AWS RDS Migration
Usage:
  npx tsx scripts/migrate-to-rds.ts [options]
  npm run migrate:rds [-- options]

Options:
  --dry-run    Only test connections and print row counts (no writes)
  --clean      Truncate RDS tables first then copy fresh
  --help       Show this message

Env vars:
  SOURCE_DATABASE_URL  or  DATABASE_URL   → Neon source
  RDS_DATABASE_URL     or  TARGET_DATABASE_URL → AWS RDS target
`);
    process.exit(0);
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║     Neon  →  AWS RDS PostgreSQL Migration           ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Validate URLs
  if (!RAW_SOURCE) {
    console.error("❌ SOURCE_DATABASE_URL (or DATABASE_URL) is not set in .env");
    process.exit(1);
  }
  if (!RAW_TARGET) {
    console.error("❌ RDS_DATABASE_URL (or TARGET_DATABASE_URL) is not set in .env");
    process.exit(1);
  }
  if (RAW_SOURCE.trim() === RAW_TARGET.trim()) {
    console.error("❌ Source and Target URLs are identical — aborting to prevent data loss");
    process.exit(1);
  }

  console.log(`Source : ${maskUrl(RAW_SOURCE)}`);
  console.log(`Target : ${maskUrl(RAW_TARGET)}`);
  console.log(`Mode   : ${isDryRun ? "🔍 DRY RUN (no changes)" : isClean ? "🧹 CLEAN + COPY" : "🔄 UPSERT (incremental)"}`);
  console.log();

  const srcPool = makePool(RAW_SOURCE);
  const tgtPool = makePool(RAW_TARGET);

  const t0 = Date.now();

  try {
    // ── 1. Test connections ──────────────────────────────────────────────
    console.log("── Step 1: Testing Connections ─────────────────────────────");

    const srcClient = await srcPool.connect();
    const srcVer    = await srcClient.query("SELECT version()");
    const srcVersion = srcVer.rows[0].version.split("on")[0].trim();
    srcClient.release();
    console.log(`✅ Source (Neon)    : ${srcVersion}`);

    const tgtClient = await tgtPool.connect();
    const tgtVer    = await tgtClient.query("SELECT version()");
    const tgtVersion = tgtVer.rows[0].version.split("on")[0].trim();
    tgtClient.release();
    console.log(`✅ Target (AWS RDS) : ${tgtVersion}`);
    console.log();

    // ── 2. Source row counts ─────────────────────────────────────────────
    console.log("── Step 2: Source Row Counts ───────────────────────────────");
    const TABLES = [
      { name: "sync_metadata",  pk: ["key"],                      order: "key" },
      { name: "name_genders",   pk: ["name"],                     order: "name" },
      { name: "users",          pk: ["id"],                       order: "created_at, id" },
      { name: "chat_sessions",  pk: ["id"],                       order: "created_at, id" },
      { name: "chat_messages",  pk: ["id"],                       order: "created_at, id" },
      { name: "notion_pages",   pk: ["id"],                       order: "synced_at, id" },
      { name: "notion_chunks",  pk: ["page_id", "chunk_index"],   order: "page_id, chunk_index" },
    ];

    const sc = await srcPool.connect();
    const sourceCounts: Record<string, number> = {};
    for (const t of TABLES) {
      if (await tableExists(sc, t.name)) {
        sourceCounts[t.name] = await rowCount(sc, t.name);
        console.log(`   ${t.name.padEnd(20)} : ${sourceCounts[t.name].toLocaleString()} rows`);
      } else {
        console.log(`   ${t.name.padEnd(20)} : (table not found — skip)`);
      }
    }
    sc.release();
    console.log();

    if (isDryRun) {
      console.log("🔍 DRY RUN complete — no changes written to RDS.");
      console.log(`   Re-run without --dry-run to perform the actual migration.\n`);
      return;
    }

    // ── 3. Create schema on RDS ──────────────────────────────────────────
    console.log("── Step 3: Provisioning Schema on RDS ──────────────────────");
    const schemaClient = await tgtPool.connect();
    try {
      await createSchema(schemaClient);
    } finally {
      schemaClient.release();
    }
    console.log();

    // ── 4. Optional clean ────────────────────────────────────────────────
    if (isClean) {
      console.log("── Step 4a: Truncating RDS Tables (--clean) ────────────────");
      const cleanClient = await tgtPool.connect();
      try {
        const tableNames = [...TABLES].reverse().map(t => `"${t.name}"`).join(", ");
        await cleanClient.query(`TRUNCATE ${tableNames} RESTART IDENTITY CASCADE;`);
        console.log(`   ✅ Truncated: ${tableNames}`);
      } finally {
        cleanClient.release();
      }
      console.log();
    }

    // ── 5. Copy tables ───────────────────────────────────────────────────
    console.log("── Step 5: Copying Data ────────────────────────────────────");
    const stats: { name: string; src: number; dst: number }[] = [];

    for (const t of TABLES) {
      if (!(t.name in sourceCounts)) continue;
      process.stdout.write(`\n➜  Migrating '${t.name}'...\n`);

      const { copied } = await copyTable(srcPool, tgtPool, t.name, t.pk, t.order);

      const tc = await tgtPool.connect();
      const dstCount = await rowCount(tc, t.name);
      tc.release();

      stats.push({ name: t.name, src: sourceCounts[t.name], dst: dstCount });
    }

    // ── 6. Verification report ───────────────────────────────────────────
    console.log("\n── Step 6: Verification Report ─────────────────────────────");
    console.log("┌──────────────────────┬────────────┬────────────┬──────────────┐");
    console.log("│ Table                │ Source     │ RDS        │ Status       │");
    console.log("├──────────────────────┼────────────┼────────────┼──────────────┤");

    let allOk = true;
    for (const s of stats) {
      const ok = s.src === s.dst;
      if (!ok) allOk = false;
      const status = ok ? "MATCH  ✅" : "MISMATCH ⚠️";
      console.log(
        `│ ${s.name.padEnd(20)} │ ${String(s.src).padStart(10)} │ ${String(s.dst).padStart(10)} │ ${status.padEnd(12)} │`
      );
    }
    console.log("└──────────────────────┴────────────┴────────────┴──────────────┘");

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (allOk) {
      console.log(`\n🎉 Migration COMPLETE in ${elapsed}s — all row counts match!`);
      console.log("   Next step: update DATABASE_URL in .env to point to your RDS instance.\n");
    } else {
      console.warn(`\n⚠️  Migration finished in ${elapsed}s but some counts differ.`);
      console.warn("   Try running with --clean for a fresh wipe-and-copy.\n");
    }

  } catch (err: any) {
    console.error("\n💥 Migration failed:", err.message ?? err);
    process.exit(1);
  } finally {
    await srcPool.end().catch(() => {});
    await tgtPool.end().catch(() => {});
  }
}

main();
