import "dotenv/config";
import { fetchProjectPages, aggregatePeopleOnProject } from "../src/lib/sql/team-roster";
import { pool } from "../src/lib/db/postgres";

async function main() {
  const pages = await fetchProjectPages("Datapivot ai project nagaada");
  console.log("Found pages count:", pages.length);
  console.log("Pages found:", pages.map(p => ({id: p.id, title: p.title})));

  const members = await aggregatePeopleOnProject(pages);
  console.log("Aggregated members count:", members.length);
  console.log("Aggregated members:", members);

  await pool.end();
}

main().catch(console.error);
