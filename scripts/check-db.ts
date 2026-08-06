import "dotenv/config";
import { pool } from "@/lib/db/postgres";

async function main() {
  const result = await pool.query(
    "SELECT id, title, owner, doc_type, status, due_date, notion_edited_at FROM notion_pages WHERE title ILIKE '%mahendra%' OR owner ILIKE '%mahendra%' OR content ILIKE '%mahendra%';"
  );
  console.log("Pages relating to Mahendra:", result.rows);
  await pool.end();
}

main().catch(console.error);


