import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";

async function test() {
  const query1 = "what my role in ng? based on my tasks";
  const query2 = "what Tamanna role in ng? based on Tamanna tasks";
  
  console.log("Resolving query 1:", query1);
  const res1 = await resolveQuery(query1);
  console.log("Result 1:", JSON.stringify(res1, null, 2));
  
  console.log("\nResolving query 2:", query2);
  const res2 = await resolveQuery(query2);
  console.log("Result 2:", JSON.stringify(res2, null, 2));
}

test().catch(console.error);
