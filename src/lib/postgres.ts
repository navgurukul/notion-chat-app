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
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

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
        synced_at       TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_embedding_idx
      ON notion_pages USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
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

    schemaEnsured = true;
    console.log("Database schema ready");
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
