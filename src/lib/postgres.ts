import { Pool } from "pg";

let pool: Pool | null = null;
let schemaEnsured = false;

function getPostgresUrl() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL is not set");
  }
  return url;
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getPostgresUrl(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function ensureSchema() {
  if (schemaEnsured) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(2026051201);");

    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email             TEXT NOT NULL UNIQUE,
        name              TEXT,
        image_url         TEXT,
        provider          TEXT DEFAULT 'google',
        provider_user_id  TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at     TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL DEFAULT 'New Chat',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('user', 'bot')),
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notion_pages (
        id              TEXT PRIMARY KEY,
        title           TEXT,
        url             TEXT,
        owner           TEXT,
        created_by      TEXT,
        last_edited_by  TEXT,
        doc_type        TEXT,
        status          TEXT,
        due_date        DATE,
        content         TEXT,
        embedding       vector(768),
        synced_at       TIMESTAMPTZ DEFAULT now(),
        notion_edited_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      ALTER TABLE notion_pages
      ADD COLUMN IF NOT EXISTS notion_edited_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_embedding_idx
      ON notion_pages USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notion_chunks (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        page_id          TEXT NOT NULL REFERENCES notion_pages(id) ON DELETE CASCADE,
        chunk_index      INT NOT NULL,
        section_heading  TEXT,
        content          TEXT NOT NULL,
        embedding        vector(768),
        fts              tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (page_id, chunk_index)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_chunks_page_id_idx
      ON notion_chunks (page_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_chunks_embedding_idx
      ON notion_chunks USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_chunks_fts_idx
      ON notion_chunks USING gin (fts);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_fts_idx
      ON notion_pages USING gin(
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_owner_idx
      ON notion_pages (lower(owner));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_created_by_idx
      ON notion_pages (lower(created_by));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_last_edited_by_idx
      ON notion_pages (lower(last_edited_by));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_notion_edited_at_idx
      ON notion_pages (notion_edited_at DESC NULLS LAST);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS users_email_idx
      ON users (email);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_idx
      ON chat_sessions (user_id, updated_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
      ON chat_messages (session_id, created_at ASC);
    `);

    await client.query("COMMIT");
    schemaEnsured = true;
    console.log("Database schema ready");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}
