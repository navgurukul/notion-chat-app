import "dotenv/config";
import { syncNotionToPostgres, isSyncInProgress } from "../src/lib/ingestion/sync";

const DEFAULT_SYNC_INTERVAL_HOURS = 4;

function getSyncIntervalMs(): number {
  const envHours = Number(process.env.SYNC_INTERVAL_HOURS);
  const hours = Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_SYNC_INTERVAL_HOURS;
  return hours * 60 * 60 * 1000;
}

async function runSyncTask(reason: string) {
  if (isSyncInProgress()) {
    console.log(`[cron-daemon] Sync already in progress, skipping (${reason}).`);
    return;
  }

  console.log(`\n[cron-daemon] Running Notion sync (${reason} - ${new Date().toISOString()})...`);
  try {
    const result = await syncNotionToPostgres({
      embed: process.env.EMBEDDINGS_ENABLED !== "false",
    });
    console.log(`[cron-daemon] Notion sync completed! Total: ${result.totalPages}, Upserted: ${result.upserted}, Skipped: ${result.skipped}`);
  } catch (error) {
    console.error(`[cron-daemon] Notion sync error (${reason}):`, error);
  }
}

async function startCronDaemon() {
  const intervalMs = getSyncIntervalMs();
  const hours = intervalMs / (60 * 60 * 1000);

  console.log(`🚀 Starting Notion 4-Hour Background Sync Daemon...`);
  console.log(`   Schedule: Every ${hours} hour(s) (${intervalMs} ms)`);
  console.log(`   Press Ctrl+C to stop.\n`);

  // Run immediately on boot
  await runSyncTask("initial-start");

  // Schedule recurring runs
  setInterval(() => {
    runSyncTask("scheduled-interval");
  }, intervalMs);
}

startCronDaemon();
