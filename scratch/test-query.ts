import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { parseQueryByRules } from "../src/lib/query/rules";
import { lazyResolveSqlEntities } from "../src/lib/query/entity-resolver";
import { handleMetadataQuery } from "../src/lib/sql/answers";

async function main() {
  const history = [
    { role: "user" as const, content: "List the task for Amruta" },
    { role: "bot" as const, content: "Bharat FPO Finder, Nav-Track Tasks, Activity Tracker..." }
  ];

  console.log("=== Query 1: List the task for the project Bharat FPO Finder ===");
  const q1 = "List the task for the project Bharat FPO Finder";
  const resolved1 = await resolveQuery(q1, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("Resolved 1:", resolved1);
  const sqlResolved1 = await lazyResolveSqlEntities(resolved1, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("SQL Resolved 1:", sqlResolved1);
  const answer1 = await handleMetadataQuery(sqlResolved1);
  console.log("Answer 1:", answer1);

  console.log("\n=== Query 2: could you tell me what are the task for PDLD ===");
  const q2 = "could you tell me what are the task for PDLD";
  const resolved2 = await resolveQuery(q2, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("Resolved 2:", resolved2);
  const sqlResolved2 = await lazyResolveSqlEntities(resolved2, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("SQL Resolved 2:", sqlResolved2);
  const answer2 = await handleMetadataQuery(sqlResolved2);
  console.log("Answer 2:", answer2);

  console.log("\n=== Query 3: Who is the most active team member in PDLD ===");
  const q3 = "Who is the most active team member in PDLD";
  const resolved3 = await resolveQuery(q3, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("Resolved 3:", resolved3);

  console.log("\n=== Query 4: list of all team member name ===");
  const q4 = "list of all team member name";
  const resolved4 = await resolveQuery(q4, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("Resolved 4:", resolved4);
  const sqlResolved4 = await lazyResolveSqlEntities(resolved4, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("SQL Resolved 4:", sqlResolved4);
  const answer4 = await handleMetadataQuery(sqlResolved4);
  console.log("Answer 4:", answer4);
  
  console.log("\n=== Query 5: list of all task for Mahendra ===");
  const q5 = "list of all task for Mahendra";
  const resolved5 = await resolveQuery(q5, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("Resolved 5:", resolved5);
  const sqlResolved5 = await lazyResolveSqlEntities(resolved5, history, "Test User", {
    lastPerson: "Amruta"
  });
  console.log("SQL Resolved 5:", sqlResolved5);
  const answer5 = await handleMetadataQuery(sqlResolved5);
  console.log("Answer 5:", answer5);
  
  process.exit(0);
}

main().catch(console.error);
