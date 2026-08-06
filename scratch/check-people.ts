import "dotenv/config";
import { getPeopleDirectory } from "../src/lib/db/team-members";

async function main() {
  const dir = await getPeopleDirectory();
  console.log("ALL PEOPLE IN DIRECTORY:", dir.map(p => p.name));
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
