import dns from "dns";
import { Pool, type PoolClient } from "pg";

// Hook DNS lookup to force IPv4 (family: 4) specifically for Neon database hosts.
// This prevents connection timeouts caused by Node's parallel IPv6/IPv4 lookup 
// implementation (autoSelectFamily) on networks where IPv6 is present but blocked.
const originalLookup = dns.lookup;
// @ts-ignore
dns.lookup = function (hostname: string, options: any, callback: any) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  if (hostname && hostname.includes("neon.tech")) {
    options.family = 4;
    options.hints = (options.hints || 0) & ~dns.ADDRCONFIG;
  }
  return originalLookup(hostname, options, callback);
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not defined");
}

const globalForPostgres = globalThis as unknown as {
  pool: Pool | undefined;
  schemaReady: boolean | undefined;
  schemaPromise: Promise<void> | null | undefined;
};

export const pool =
  globalForPostgres.pool ??
  new Pool({
    connectionString: databaseUrl,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPostgres.pool = pool;
}

let schemaReady = globalForPostgres.schemaReady ?? false;
let schemaPromise = globalForPostgres.schemaPromise ?? null;

const SCHEMA_ADVISORY_LOCK_ID = 9_152_4001;

async function safeCreateTable(client: PoolClient, sql: string) {
  try {
    await client.query(sql);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23505" || code === "42P07") return;
    throw error;
  }
}

type ColumnMigration = {
  table: string;
  column: string;
  definition: string;
};

const CORE_COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: "users", column: "name", definition: "TEXT" },
  { table: "users", column: "image_url", definition: "TEXT" },
  { table: "users", column: "provider", definition: "TEXT DEFAULT 'google'" },
  { table: "users", column: "last_login_at", definition: "TIMESTAMP" },
  {
    table: "users",
    column: "updated_at",
    definition: "TIMESTAMP DEFAULT NOW()",
  },
  {
    table: "chat_sessions",
    column: "updated_at",
    definition: "TIMESTAMP DEFAULT NOW()",
  },
  {
    table: "chat_messages",
    column: "emotion",
    definition: "TEXT",
  },
];

const NOTION_PAGE_COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: "notion_pages", column: "url", definition: "TEXT" },
  { table: "notion_pages", column: "owner", definition: "TEXT" },
  { table: "notion_pages", column: "created_by", definition: "TEXT" },
  { table: "notion_pages", column: "last_edited_by", definition: "TEXT" },
  { table: "notion_pages", column: "doc_type", definition: "TEXT" },
  { table: "notion_pages", column: "status", definition: "TEXT" },
  { table: "notion_pages", column: "due_date", definition: "TEXT" },
  { table: "notion_pages", column: "embedding", definition: "vector(1536)" },
  {
    table: "notion_pages",
    column: "notion_edited_at",
    definition: "TIMESTAMP",
  },
  {
    table: "notion_pages",
    column: "embedding_status",
    definition: "TEXT DEFAULT 'pending'",
  },
  { table: "notion_pages", column: "last_error", definition: "TEXT" },
];

// FIX (Schema): Added heading_path, char_count, token_count migrations.
// These columns are required by sync.ts bulk insert.
const NOTION_CHUNK_COLUMN_MIGRATIONS: ColumnMigration[] = [
  { table: "notion_chunks", column: "heading_path", definition: "TEXT" },
  {
    table: "notion_chunks",
    column: "char_count",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "notion_chunks",
    column: "token_count",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
];

async function columnExists(client: PoolClient, table: string, column: string) {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [table, column],
  );
  return result.rows.length > 0;
}

async function tableExists(client: PoolClient, table: string) {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
    LIMIT 1
    `,
    [table],
  );
  return result.rows.length > 0;
}

async function reconcileNotionPagesSchema(client: PoolClient) {
  if (!(await tableExists(client, "notion_pages"))) return;

  const hasUrl = await columnExists(client, "notion_pages", "url");
  const hasLegacyNotionPageId = await columnExists(
    client,
    "notion_pages",
    "notion_page_id",
  );

  if (hasUrl && !hasLegacyNotionPageId) return;

  const count = await client.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM notion_pages",
  );
  const rowCount = Number(count.rows[0]?.count ?? "0");

  if (rowCount > 0) {
    throw new Error(
      "notion_pages table uses an old schema with data. Drop or migrate it manually before syncing.",
    );
  }

  await client.query("DROP TABLE IF EXISTS notion_chunks CASCADE");
  await client.query("DROP TABLE IF EXISTS notion_pages CASCADE");
}

async function ensureNotionChunksSchema(client: PoolClient) {
  // FIX (Schema): CREATE TABLE now includes heading_path, char_count, token_count.
  // FIX (FTS):    Using 'simple' dictionary consistently (was 'english' in ALTER TABLE).
  //               'simple' = no stemming, works for all languages in your workspace.
  await safeCreateTable(
    client,
    `
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
      fts           tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', coalesce(content, ''))
                    ) STORED,
      UNIQUE (page_id, chunk_index)
    );
  `,
  );

  // FIX (FTS): ALTER TABLE also uses 'simple' now (was 'english' — inconsistent).
  if (!(await columnExists(client, "notion_chunks", "fts"))) {
    await client.query(`
      ALTER TABLE notion_chunks
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(content, ''))
      ) STORED
    `);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS notion_chunks_embedding_idx
    ON notion_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS notion_chunks_fts_idx
    ON notion_chunks
    USING gin (fts);
  `);
}

async function addColumnIfMissing(
  client: PoolClient,
  { table, column, definition }: ColumnMigration,
) {
  const exists = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [table, column],
  );

  if (exists.rows.length > 0) return;
  if (!(await tableExists(client, table))) return;

  await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function runColumnMigrations(
  client: PoolClient,
  migrations: ColumnMigration[],
) {
  for (const migration of migrations) {
    await addColumnIfMissing(client, migration);
  }
}

export async function ensureSchema() {
  if (schemaReady) return;

  if (schemaPromise) {
    await schemaPromise;
    return;
  }

  schemaPromise = (async () => {
    const client = await pool.connect();

    try {
      await client.query("SELECT pg_advisory_lock($1)", [
        SCHEMA_ADVISORY_LOCK_ID,
      ]);

      await client.query(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
      `);

      await safeCreateTable(
        client,
        `
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
      `,
      );

      await safeCreateTable(
        client,
        `
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          title TEXT DEFAULT 'New Chat',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `,
      );

      await client.query(`
        CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);
      `);

      await runColumnMigrations(client, CORE_COLUMN_MIGRATIONS);

      await safeCreateTable(
        client,
        `
        CREATE TABLE IF NOT EXISTS chat_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          emotion TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `,
      );

      await client.query(`
        CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages(session_id);
        CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages(session_id, created_at DESC);
      `);

      await reconcileNotionPagesSchema(client);

      await safeCreateTable(
        client,
        `
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
      `,
      );

      await runColumnMigrations(client, NOTION_PAGE_COLUMN_MIGRATIONS);

      // Indexes for resume-mode queries (WHERE embedding_status = 'completed')
      // and for incremental sync comparisons (notion_edited_at check).
      await client.query(`
        CREATE INDEX IF NOT EXISTS notion_pages_embedding_status_idx
        ON notion_pages (embedding_status);

        CREATE INDEX IF NOT EXISTS notion_pages_edited_idx
        ON notion_pages (notion_edited_at);

        CREATE INDEX IF NOT EXISTS notion_pages_synced_at_idx
        ON notion_pages (synced_at);
      `);

      await ensureNotionChunksSchema(client);

      // FIX (Schema): Run chunk column migrations for existing tables
      // that were created before heading_path/char_count/token_count were added.
      await runColumnMigrations(client, NOTION_CHUNK_COLUMN_MIGRATIONS);

      await safeCreateTable(
        client,
        `
        CREATE TABLE IF NOT EXISTS sync_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `,
      );

      schemaReady = true;
      globalForPostgres.schemaReady = true;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [SCHEMA_ADVISORY_LOCK_ID])
        .catch(() => undefined);
      client.release();
    }
  })().catch((error) => {
    schemaPromise = null;
    globalForPostgres.schemaPromise = null;
    throw error;
  });

  globalForPostgres.schemaPromise = schemaPromise;
  await schemaPromise;
}

/**
 * Get a dedicated pool client for multi-statement transactions.
 * Caller must call client.release() in a finally block.
 *
 * Usage:
 *   const client = await getClient();
 *   try {
 *     await client.query("BEGIN");
 *     ...
 *     await client.query("COMMIT");
 *   } catch (err) {
 *     await client.query("ROLLBACK").catch(() => undefined);
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 */
export async function getClient() {
  await ensureSchema();
  return pool.connect();
}

export async function query<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  await ensureSchema();

  const result = await pool.query(text, params);

  return result.rows as T[];
}