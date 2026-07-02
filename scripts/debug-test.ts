import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";

async function run() {
  const parsed = await resolveQuery("provide summry of - Team Learning & Session Report – 02 May");
  console.log("Parsed Query:", parsed);
  const answer = await handleMetadataQuery(parsed);
  console.log("Answer:", answer);
}
run().catch(console.error);
