import { Pool, type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not defined");
}

const globalForPostgres = globalThis as unknown as {
  pool: Pool | undefined;
  schemaReady: boolean | undefined;
  schemaPromise: Promise<void> | null | undefined;
};

export const pool = globalForPostgres.pool ?? new Pool({
  connectionString: databaseUrl,
});

if (process.env.NODE_ENV !== "production") {
  globalForPostgres.pool = pool;
}

let schemaReady = globalForPostgres.schemaReady ?? false;
let schemaPromise = globalForPostgres.schemaPromise ?? null;

const SCHEMA_ADVISORY_LOCK_ID = 9_152_4001;

async function safeCreateTable(
  client: PoolClient,
  sql: string,
) {
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
  { table: "users", column: "updated_at", definition: "TIMESTAMP DEFAULT NOW()" },
  { table: "chat_sessions", column: "updated_at", definition: "TIMESTAMP DEFAULT NOW()" },
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
  { table: "notion_pages", column: "notion_edited_at", definition: "TIMESTAMP" },
  {
    table: "notion_pages",
    column: "embedding_status",
    definition: "TEXT DEFAULT 'pending'",
  },
  { table: "notion_pages", column: "last_error", definition: "TEXT" },
];

async function columnExists(
  client: PoolClient,
  table: string,
  column: string,
) {
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

async function tableExists(
  client: PoolClient,
  table: string,
) {
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

/** v2 bootstrap used uuid id + notion_page_id; sync expects Notion page id as TEXT primary key. */
async function reconcileNotionPagesSchema(
  client: PoolClient,
) {
  if (!(await tableExists(client, "notion_pages"))) return;

  const hasUrl = await columnExists(client, "notion_pages", "url");
  const hasLegacyNotionPageId = await columnExists(client, "notion_pages", "notion_page_id");

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

async function ensureNotionChunksSchema(
  client: PoolClient,
) {
  await safeCreateTable(
    client,
    `
    CREATE TABLE IF NOT EXISTS notion_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id TEXT NOT NULL REFERENCES notion_pages(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      section_heading TEXT,
      content TEXT NOT NULL,
      embedding vector(1536),
      fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
      UNIQUE (page_id, chunk_index)
    );
  `,
  );

  if (!(await columnExists(client, "notion_chunks", "fts"))) {
    await client.query(`
      ALTER TABLE notion_chunks
      ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
    `);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS notion_chunks_embedding_idx
    ON notion_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
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
      await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_ADVISORY_LOCK_ID]);

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

      await ensureNotionChunksSchema(client);

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
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_ADVISORY_LOCK_ID]).catch(
        () => undefined,
      );
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

export async function query<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  await ensureSchema();

  const result = await pool.query(text, params);

  return result.rows as T[];
}