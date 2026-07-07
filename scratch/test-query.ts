import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { parseQueryByRules } from "../src/lib/query/rules";

async function main() {
  const q1 = "anu role , but task shivash is working on...";
  console.log("=== Rules Parse ===");
  console.log(parseQueryByRules(q1));

  console.log("\n=== Resolve Query ===");
  const resolved = await resolveQuery(q1, [], "Test User", {
    lastProject: "Bharat FPO Finder",
    lastPerson: "Mahendra"
  });
  console.log(resolved);
}

main().catch(console.error);
