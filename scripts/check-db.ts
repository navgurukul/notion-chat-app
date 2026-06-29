import "dotenv/config";
import { pool } from "@/lib/db/postgres";

async function main() {
  const rows = await pool.query(
    "SELECT id, title, owner, created_by, last_edited_by FROM notion_pages WHERE content ILIKE '%Sakshi%';"
  );
  console.log("Pages containing Sakshi:", rows.rows);
  await pool.end();
}

main().catch(console.error);
