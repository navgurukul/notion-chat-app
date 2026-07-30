import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { lazyResolveSqlEntities } from "../src/lib/query/entity-resolver";
import { handleMetadataQuery } from "../src/lib/sql/answers";

async function main() {
  const history = [
    { role: "user" as const, content: "list of all task for Mahendra" },
    { role: "bot" as const, content: "## 20 result(s) — task(s) assigned to Mahendra..." }
  ];

  console.log("=== Query: give me the task for the mahendra on 23 july 2026 ===");
  const q = "give me the task for the mahendra on 23 july 2026";
  const resolved = await resolveQuery(q, history, "Test User", {
    lastPerson: "Mahendra"
  });
  console.log("Resolved:", resolved);
  const sqlResolved = await lazyResolveSqlEntities(resolved, history, "Test User", {
    lastPerson: "Mahendra"
  });
  console.log("SQL Resolved:", sqlResolved);
  const answer = await handleMetadataQuery(sqlResolved);
  console.log("Answer:", answer);
  
  process.exit(0);
}

main().catch(console.error);
