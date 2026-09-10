import "dotenv/config";
import { syncNotionToPostgres } from "../src/lib/ingestion/sync";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const refreshContent = args.includes("--refresh-content");
  const resume = args.includes("--resume");

  let limit: number | undefined;
  const limitArg = args.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    limit = parseInt(limitArg.split("=")[1], 10);
  }

  const embedArg = args.find((a) => a.startsWith("--embed="));
  const embed = embedArg ? embedArg.split("=")[1] !== "false" : true;

  console.log("[sync-script] Starting Notion to Postgres sync...");
  console.log(`[sync-script] Options: force=${force}, refreshContent=${refreshContent}, resume=${resume}, embed=${embed}${limit ? `, limit=${limit}` : ""}`);

  const startTime = Date.now();

  try {
    const result = await syncNotionToPostgres({
      force,
      refreshContent,
      resume,
      limit,
      embed,
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Sync complete in ${elapsedSec}s!`);
    console.log(`   Total Pages:       ${result.totalPages}`);
    console.log(`   Upserted:          ${result.upserted}`);
    console.log(`   Skipped:           ${result.skipped}`);
    console.log(`   Retried:           ${result.retried}`);
    console.log(`   Embeddings Failed: ${result.embeddingsFailed}`);
    console.log(`   Synced At:         ${result.synced_at}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Notion sync failed:", error);
    process.exit(1);
  }
}

main();
