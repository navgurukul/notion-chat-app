import "dotenv/config";
import { query, getPool } from "../src/lib/postgres";

async function main() {
  const resumeRows = await query("SELECT title, owner FROM notion_pages WHERE lower(title) LIKE '%resume prompt%'");
  console.log("Resume Prompts:", resumeRows);

  await getPool().end();
}
main().catch(console.error);
