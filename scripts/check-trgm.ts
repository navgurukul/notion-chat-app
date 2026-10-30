import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

async function main() {
  console.log("Attempting: CREATE EXTENSION IF NOT EXISTS pg_trgm ...");
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    console.log("✅ Extension created (or already existed).");
  } catch (error) {
    console.error("❌ CREATE EXTENSION failed with:");
    console.error(error);
    await pool.end();
    return;
  }

  console.log("\nAttempting: CREATE INDEX notion_pages_title_trgm_idx ...");
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS notion_pages_title_trgm_idx
      ON notion_pages
      USING gin (title gin_trgm_ops)
    `);
    console.log("✅ Index created (or already existed).");
  } catch (error) {
    console.error("❌ CREATE INDEX failed with:");
    console.error(error);
  }

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'notion_pages' AND indexname = 'notion_pages_title_trgm_idx'`,
  );
  console.log(idx.rows.length ? "\nFinal check — Index exists ✅" : "\nFinal check — Index still missing ❌");

  await pool.end();
}

main();