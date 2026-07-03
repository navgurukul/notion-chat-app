import "dotenv/config";
import { query } from "../src/lib/db";

async function main() {
  const result = await query<{ name: string }>(`
    SELECT DISTINCT name FROM (
      SELECT trim(unnest(string_to_array(owner, ','))) AS name FROM notion_pages WHERE owner IS NOT NULL
      UNION
      SELECT trim(created_by) FROM notion_pages WHERE created_by IS NOT NULL
      UNION
      SELECT trim(last_edited_by) FROM notion_pages WHERE last_edited_by IS NOT NULL
    ) AS people
    ORDER BY name;
  `);
  console.log("Distinct names in DB:", result.map(r => r.name));
}

main().catch(console.error);
