import { Pool } from "pg";

let pool: Pool | null = null;
let schemaReady = false;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL is missing in environment variables");
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  // Auto-create schema on first query so the app works before sync is run
  if (!schemaReady) {
    await ensureSchema();
    schemaReady = true;
  }
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Run once to set up the database schema.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export async function ensureSchema(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Enable pgvector extension
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Notion pages metadata table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notion_pages (
        id            TEXT PRIMARY KEY,
        title         TEXT,
        owner         TEXT,
        created_by    TEXT,
        last_edited_by TEXT,
        type          TEXT,
        status        TEXT,
        stage         TEXT,
        url           TEXT,
        created_on    TEXT,
        last_edited   TEXT,
        content       TEXT,
        embedding     vector(768),
        last_synced   TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Indexes for fast property filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_owner
        ON notion_pages (lower(owner))
        WHERE owner IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_created_by
        ON notion_pages (lower(created_by))
        WHERE created_by IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_type
        ON notion_pages (lower(type))
        WHERE type IS NOT NULL
    `);

    // Index for vector similarity search
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_embedding
        ON notion_pages
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 50)
    `);

    await client.query("COMMIT");
    console.log("✅ Database schema ready");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
