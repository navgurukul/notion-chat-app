#!/usr/bin/env tsx
/**
 * migrate-to-rds.ts
 *
 * Enterprise-grade migration script to transfer all schema, data, relations,
 * and pgvector embeddings from your current database (Neon / local PostgreSQL)
 * to AWS RDS PostgreSQL.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-rds.ts [options]
 *
 * Options:
 *   --target, -t <url>     Target AWS RDS PostgreSQL connection string
 *   --source, -s <url>     Source PostgreSQL connection string (default: DATABASE_URL from .env)
 *   --clean                Truncate target tables before inserting (fresh migration)
 *   --dry-run              Test connections and preview row counts without writing to target
 *   --batch-size <num>     Number of rows per insert batch (default: 250)
 *   --skip-schema          Skip DDL/index creation on target (assumes schema already exists)
 *   --help, -h             Show help message
 */

import "@/lib/dns-hook";
import * as dns from "dns";
import "dotenv/config";
import { Pool, type PoolClient } from "pg";

// ---------------------------------------------------------------------------
// CLI Arguments Parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  sourceUrl: string;
  targetUrl: string;
  clean: boolean;
  dryRun: boolean;
  batchSize: number;
  skipSchema: boolean;
  help: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let sourceUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || "";
  let targetUrl = process.env.TARGET_DATABASE_URL || process.env.RDS_DATABASE_URL || "";
  let clean = false;
  let dryRun = false;
  let batchSize = 250;
  let skipSchema = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--clean") {
      clean = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-schema") {
      skipSchema = true;
    } else if (arg.startsWith("--batch-size=")) {
      batchSize = parseInt(arg.split("=")[1], 10) || 250;
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      batchSize = parseInt(args[++i], 10) || 250;
    } else if (arg.startsWith("--source=")) {
      sourceUrl = arg.split("=")[1];
    } else if ((arg === "--source" || arg === "-s") && i + 1 < args.length) {
      sourceUrl = args[++i];
    } else if (arg.startsWith("--target=")) {
      targetUrl = arg.split("=")[1];
    } else if ((arg === "--target" || arg === "-t") && i + 1 < args.length) {
      targetUrl = args[++i];
    }
  }

  return { sourceUrl, targetUrl, clean, dryRun, batchSize, skipSchema, help };
}

function printHelp() {
  console.log(`
=============================================================================
  Notion Chat App -> AWS RDS PostgreSQL Migration Script
=============================================================================

Transfers all schema, relations, metadata, and pgvector embeddings
from your current database to AWS RDS PostgreSQL.

Usage:
  npx tsx scripts/migrate-to-rds.ts [options]
  npm run migrate:rds -- [options]

Environment Variables:
  SOURCE_DATABASE_URL   Source Postgres URL (defaults to DATABASE_URL in .env)
  TARGET_DATABASE_URL   Target AWS RDS Postgres URL (or RDS_DATABASE_URL)

Options:
  --target, -t <url>     Target AWS RDS connection string
  --source, -s <url>     Source connection string (default: DATABASE_URL from .env)
  --clean                Truncate target tables before copying data
  --dry-run              Test connections and report row counts without writing
  --batch-size <num>     Rows per bulk insert batch (default: 250)
  --skip-schema          Skip table/index creation on target
  --help, -h             Show this help screen

Examples:
  1. Dry-run inspection:
     npm run migrate:rds -- --dry-run --target="postgresql://admin:pass@rds-endpoint:5432/notion_chat"

  2. Fresh full migration to RDS:
     npm run migrate:rds -- --clean --target="postgresql://admin:pass@rds-endpoint:5432/notion_chat?sslmode=require"

  3. Incremental / Idempotent sync:
     npm run migrate:rds -- --target="postgresql://admin:pass@rds-endpoint:5432/notion_chat?sslmode=require"
`);
}

// ---------------------------------------------------------------------------
// Database Connection Pools
// ---------------------------------------------------------------------------

function sanitizeUrlForLogs(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "******";
    }
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

function createPool(connectionString: string, label: string): Pool {
  let url = connectionString.trim();

  // Normalize sslmode for node-postgres
  if (url.includes("sslmode=require")) {
    url = url.replace("sslmode=require", "sslmode=verify-full");
  } else if (url.includes("sslmode=prefer")) {
    url = url.replace("sslmode=prefer", "sslmode=verify-full");
  } else if (url.includes("sslmode=verify-ca")) {
    url = url.replace("sslmode=verify-ca", "sslmode=verify-full");
  }

  const isSslNeeded =
    url.includes("sslmode=") ||
    url.includes("neon.tech") ||
    url.includes("rds.amazonaws.com") ||
    url.includes(".aws.");

  const config: any = {
    connectionString: url,
    lookup: dns.lookup,
    ssl: isSslNeeded ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  };

  return new Pool(config);
}

// ---------------------------------------------------------------------------
// Table Definitions & Topological Order
// ---------------------------------------------------------------------------

interface TableMeta {
  name: string;
  primaryKey: string[];
  orderBy: string;
}

const TABLES: TableMeta[] = [
  {
    name: "sync_metadata",
    primaryKey: ["key"],
    orderBy: "key",
  },
  {
    name: "name_genders",
    primaryKey: ["name"],
    orderBy: "name",
  },
  {
    name: "users",
    primaryKey: ["id"],
    orderBy: "created_at, id",
  },
  {
    name: "chat_sessions",
    primaryKey: ["id"],
    orderBy: "created_at, id",
  },
  {
    name: "chat_messages",
    primaryKey: ["id"],
    orderBy: "created_at, id",
  },
  {
    name: "notion_pages",
    primaryKey: ["id"],
    orderBy: "synced_at, id",
  },
  {
    name: "notion_chunks",
    primaryKey: ["page_id", "chunk_index"],
    orderBy: "page_id, chunk_index",
  },
];

// ---------------------------------------------------------------------------
// Target Schema Initialization (DDL)
// ---------------------------------------------------------------------------

async function ensureTargetSchema(targetClient: PoolClient): Promise<void> {
  console.log("\n📦 [1/3] Ensuring Target Schema & Extensions on RDS...");

  // 1. Extensions
  console.log("   -> Checking extensions: vector, pgcrypto, pg_trgm...");
  try {
    await targetClient.query("CREATE EXTENSION IF NOT EXISTS vector;");
    console.log("      ✅ Extension 'vector' (pgvector) enabled.");
  } catch (err: any) {
    console.error("      ❌ Failed to enable 'vector' extension on RDS:", err.message);
    console.error(`
      ⚠️ NOTE: AWS RDS PostgreSQL supports 'pgvector' on PostgreSQL 15.2+.
      If this fails:
        1. Check RDS Postgres engine version (must be >= 15.2).
        2. Ensure your RDS user has RDS extension privileges or is 'rds_superuser'.
    `);
    throw err;
  }

  await targetClient.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  console.log("      ✅ Extension 'pgcrypto' enabled.");

  await targetClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  console.log("      ✅ Extension 'pg_trgm' enabled.");

  // 2. Tables & Core Indexes
  console.log("   -> Creating tables & indexes...");

  // users
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      image_url TEXT,
      provider TEXT DEFAULT 'google',
      last_login_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // chat_sessions
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      title TEXT DEFAULT 'New Chat',
      state JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);
  `);

  // chat_messages
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      emotion TEXT,
      feedback TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages(session_id, created_at DESC);
  `);

  // notion_pages
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS notion_pages (
      id TEXT PRIMARY KEY,
      title TEXT,
      url TEXT,
      owner TEXT,
      created_by TEXT,
      last_edited_by TEXT,
      doc_type TEXT,
      status TEXT,
      due_date TEXT,
      content TEXT,
      embedding vector(1536),
      synced_at TIMESTAMP DEFAULT NOW(),
      notion_edited_at TIMESTAMP,
      embedding_status TEXT DEFAULT 'pending',
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS notion_pages_embedding_status_idx ON notion_pages (embedding_status);
    CREATE INDEX IF NOT EXISTS notion_pages_edited_idx ON notion_pages (notion_edited_at);
    CREATE INDEX IF NOT EXISTS notion_pages_synced_at_idx ON notion_pages (synced_at);
  `);

  // Ensure fts on notion_pages
  const hasPageFts = await targetClient.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notion_pages' AND column_name = 'fts'
  `);
  if (hasPageFts.rows.length === 0) {
    await targetClient.query(`
      ALTER TABLE notion_pages
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
      ) STORED;
    `);
  }
  await targetClient.query(`
    CREATE INDEX IF NOT EXISTS notion_pages_fts_idx ON notion_pages USING gin (fts);
    CREATE INDEX IF NOT EXISTS notion_pages_title_trgm_idx ON notion_pages USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS notion_pages_content_trgm_idx ON notion_pages USING gin (content gin_trgm_ops);
  `);

  // notion_chunks
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS notion_chunks (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id       TEXT NOT NULL REFERENCES notion_pages(id) ON DELETE CASCADE,
      chunk_index   INTEGER NOT NULL,
      section_heading TEXT,
      heading_path  TEXT,
      content       TEXT NOT NULL,
      char_count    INTEGER NOT NULL DEFAULT 0,
      token_count   INTEGER NOT NULL DEFAULT 0,
      embedding     vector(1536),
      UNIQUE (page_id, chunk_index)
    );
  `);

  // Ensure fts on notion_chunks
  const hasChunkFts = await targetClient.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notion_chunks' AND column_name = 'fts'
  `);
  if (hasChunkFts.rows.length === 0) {
    await targetClient.query(`
      ALTER TABLE notion_chunks
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(content, ''))
      ) STORED;
    `);
  }

  // notion_chunks indexes
  await targetClient.query(`
    CREATE INDEX IF NOT EXISTS notion_chunks_embedding_idx
    ON notion_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

    CREATE INDEX IF NOT EXISTS notion_chunks_fts_idx
    ON notion_chunks
    USING gin (fts);

    CREATE INDEX IF NOT EXISTS notion_chunks_content_trgm_idx
    ON notion_chunks
    USING gin (content gin_trgm_ops);
  `);

  // name_genders
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS name_genders (
      name TEXT PRIMARY KEY,
      gender TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // sync_metadata
  await targetClient.query(`
    CREATE TABLE IF NOT EXISTS sync_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("   ✅ Target schema, tables, generated columns, and indexes ready.");
}

// ---------------------------------------------------------------------------
// Column Inspection & Formatting Helpers
// ---------------------------------------------------------------------------

async function getMigratableColumns(client: PoolClient, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string; is_generated: string }>(
    `
    SELECT column_name, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position;
    `,
    [tableName],
  );

  // Exclude generated columns (like 'fts' generated always stored)
  return result.rows
    .filter((col) => col.is_generated !== "ALWAYS" && col.column_name !== "fts")
    .map((col) => col.column_name);
}

function formatValueForInsert(columnName: string, value: any): any {
  if (value === null || value === undefined) {
    return null;
  }

  // Format vector embedding
  if (columnName === "embedding") {
    if (Array.isArray(value)) {
      return `[${value.join(",")}]`;
    }
    return String(value);
  }

  // Format JSONB state column
  if (columnName === "state" && typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

// ---------------------------------------------------------------------------
// Main Migration Engine
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  console.log("\n🚀 =========================================================");
  console.log("   DATABASE MIGRATION TO AWS RDS POSTGRESQL");
  console.log("=========================================================");

  if (!opts.sourceUrl) {
    console.error("❌ Error: SOURCE_DATABASE_URL or DATABASE_URL is not set.");
    console.error("   Provide it via .env file or --source flag.");
    process.exit(1);
  }

  if (!opts.targetUrl) {
    console.error("❌ Error: TARGET_DATABASE_URL or RDS_DATABASE_URL is not set.");
    console.error("   Provide it via .env file or --target flag.");
    console.error('   Example: npm run migrate:rds -- --target="postgresql://user:pass@rds-endpoint:5432/dbname"');
    process.exit(1);
  }

  console.log(`Source: ${sanitizeUrlForLogs(opts.sourceUrl)}`);
  console.log(`Target: ${sanitizeUrlForLogs(opts.targetUrl)}`);
  console.log(`Mode:   ${opts.dryRun ? "🔍 DRY RUN (no writes)" : "⚡ LIVE MIGRATION"}`);
  console.log(`Clean:  ${opts.clean ? "YES (will truncate target tables first)" : "NO (upsert mode)"}`);
  console.log(`Batch:  ${opts.batchSize} rows/batch\n`);

  // Prevent accidental self-migration
  if (opts.sourceUrl.trim() === opts.targetUrl.trim()) {
    console.error("❌ Refusing to run: Source and Target database URLs are identical!");
    process.exit(1);
  }

  const sourcePool = createPool(opts.sourceUrl, "Source");
  const targetPool = createPool(opts.targetUrl, "Target");

  const startTime = Date.now();

  try {
    // 1. Connectivity test
    console.log("🔌 Testing connectivity to Source...");
    const sourceClient = await sourcePool.connect();
    const sourceVer = await sourceClient.query("SELECT version();");
    console.log(`   Connected to Source: ${sourceVer.rows[0].version.split(" on ")[0]}`);
    sourceClient.release();

    console.log("🔌 Testing connectivity to Target RDS...");
    const targetClient = await targetPool.connect();
    const targetVer = await targetClient.query("SELECT version();");
    console.log(`   Connected to Target RDS: ${targetVer.rows[0].version.split(" on ")[0]}`);

    // 2. Ensure Target Schema
    if (!opts.dryRun && !opts.skipSchema) {
      await ensureTargetSchema(targetClient);
    }
    targetClient.release();

    // 3. Clean Target Tables if requested
    if (opts.clean && !opts.dryRun) {
      console.log("\n🧹 Cleaning target tables (reverse topological order)...");
      const client = await targetPool.connect();
      try {
        const reverseTableNames = [...TABLES].reverse().map((t) => `"${t.name}"`).join(", ");
        await client.query(`TRUNCATE ${reverseTableNames} CASCADE;`);
        console.log(`   ✅ Truncated: ${reverseTableNames}`);
      } finally {
        client.release();
      }
    }

    // 4. Data Migration per Table
    console.log("\n🚚 [2/3] Migrating Tables...");
    const migrationStats: Record<string, { source: number; targetBefore: number; targetAfter: number }> = {};

    for (const table of TABLES) {
      const srcClient = await sourcePool.connect();
      const tgtClient = await targetPool.connect();

      try {
        // Check if table exists in source
        const existsRes = await srcClient.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
          [table.name],
        );
        if (existsRes.rows.length === 0) {
          console.log(`   ⏭️ Table '${table.name}' does not exist on source database. Skipping.`);
          continue;
        }

        // Get total source count
        const countRes = await srcClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table.name}"`);
        const totalSourceRows = parseInt(countRes.rows[0].count, 10);

        // Get target count before migration
        let countTgtBefore = 0;
        try {
          const tgtCountRes = await tgtClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table.name}"`);
          countTgtBefore = parseInt(tgtCountRes.rows[0].count, 10);
        } catch {
          // Table may not exist yet in dry-run mode
        }

        console.log(`\n📋 Table '${table.name}': ${totalSourceRows} source rows (target has ${countTgtBefore})`);

        if (totalSourceRows === 0) {
          migrationStats[table.name] = { source: 0, targetBefore: countTgtBefore, targetAfter: countTgtBefore };
          continue;
        }

        if (opts.dryRun) {
          migrationStats[table.name] = { source: totalSourceRows, targetBefore: countTgtBefore, targetAfter: countTgtBefore };
          continue;
        }

        // Get migratable columns (excluding generated columns)
        const columns = await getMigratableColumns(srcClient, table.name);
        if (columns.length === 0) {
          console.warn(`   ⚠️ No migratable columns found for ${table.name}. Skipping.`);
          continue;
        }

        const quotedCols = columns.map((c) => `"${c}"`).join(", ");
        const primaryKeyCols = table.primaryKey.map((k) => `"${k}"`).join(", ");
        const updateSetCols = columns
          .filter((c) => !table.primaryKey.includes(c))
          .map((c) => `"${c}" = EXCLUDED."${c}"`)
          .join(", ");

        let processed = 0;
        let offset = 0;

        while (offset < totalSourceRows) {
          // Query batch from source
          const querySql = `SELECT ${quotedCols} FROM "${table.name}" ORDER BY ${table.orderBy} LIMIT $1 OFFSET $2`;
          const rowsRes = await srcClient.query(querySql, [opts.batchSize, offset]);
          const rows = rowsRes.rows;

          if (rows.length === 0) break;

          // Build multi-row INSERT query
          const valuePlaceholders: string[] = [];
          const queryParams: any[] = [];
          let paramIdx = 1;

          for (const row of rows) {
            const rowPlaceholders: string[] = [];
            for (const col of columns) {
              const formattedVal = formatValueForInsert(col, row[col]);
              queryParams.push(formattedVal);

              // pgvector cast for embedding column
              if (col === "embedding") {
                rowPlaceholders.push(`$${paramIdx}::vector`);
              } else if (col === "state") {
                rowPlaceholders.push(`$${paramIdx}::jsonb`);
              } else {
                rowPlaceholders.push(`$${paramIdx}`);
              }
              paramIdx++;
            }
            valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
          }

          let insertSql = `INSERT INTO "${table.name}" (${quotedCols}) VALUES ${valuePlaceholders.join(", ")}`;
          if (updateSetCols.length > 0) {
            insertSql += ` ON CONFLICT (${primaryKeyCols}) DO UPDATE SET ${updateSetCols}`;
          } else {
            insertSql += ` ON CONFLICT (${primaryKeyCols}) DO NOTHING`;
          }

          await tgtClient.query(insertSql, queryParams);

          processed += rows.length;
          offset += rows.length;

          const pct = Math.round((processed / totalSourceRows) * 100);
          process.stdout.write(`   -> Migrated ${processed}/${totalSourceRows} rows (${pct}%)\r`);
        }

        console.log(`   ✅ Finished '${table.name}': ${processed}/${totalSourceRows} rows migrated.`);

        // Record target count after migration
        const tgtCountAfterRes = await tgtClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table.name}"`);
        const countTgtAfter = parseInt(tgtCountAfterRes.rows[0].count, 10);
        migrationStats[table.name] = { source: totalSourceRows, targetBefore: countTgtBefore, targetAfter: countTgtAfter };
      } finally {
        srcClient.release();
        tgtClient.release();
      }
    }

    // 5. Final Verification & Summary Report
    console.log("\n📊 [3/3] Verification & Migration Summary Report");
    console.log("=============================================================================");
    console.log(
      `${"Table".padEnd(20)} | ${"Source".padEnd(10)} | ${"Target (After)".padEnd(14)} | ${"Status".padEnd(12)}`,
    );
    console.log("-----------------------------------------------------------------------------");

    let allMatched = true;
    for (const table of TABLES) {
      const stats = migrationStats[table.name];
      if (!stats) continue;

      const matched = stats.source === stats.targetAfter;
      if (!matched && !opts.dryRun) allMatched = false;

      const status = opts.dryRun
        ? "DRY RUN ℹ️"
        : matched
        ? "MATCH ✅"
        : "MISMATCH ⚠️";

      console.log(
        `${table.name.padEnd(20)} | ${String(stats.source).padStart(8)}   | ${String(stats.targetAfter).padStart(12)}   | ${status}`,
      );
    }
    console.log("=============================================================================");

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

    if (opts.dryRun) {
      console.log(`\n🔍 Dry run completed in ${durationSec}s. No changes were written to RDS.`);
      console.log("   To execute live migration, run without --dry-run.");
    } else if (allMatched) {
      console.log(`\n🎉 SUCCESS! All data migrated to AWS RDS in ${durationSec}s.`);
      console.log("   You can now switch DATABASE_URL in .env to your RDS connection string!");
    } else {
      console.warn(`\n⚠️ Migration finished in ${durationSec}s with row count mismatches.`);
      console.warn("   Review the table above or re-run with --clean to do a clean wipe and copy.");
    }
  } catch (error: any) {
    console.error("\n💥 Migration failed with fatal error:", error);
    process.exit(1);
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

main();
