import { syncNotionToPostgres, isSyncInProgress } from "./sync";

const globalForScheduler = globalThis as unknown as {
  syncSchedulerTimer?: NodeJS.Timeout;
  schedulerInitialized?: boolean;
};

const DEFAULT_SYNC_INTERVAL_HOURS = 4;

export function getSyncIntervalMs(): number {
  const envHours = Number(process.env.SYNC_INTERVAL_HOURS);
  const hours = Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_SYNC_INTERVAL_HOURS;
  return hours * 60 * 60 * 1000;
}

export function isAutoSyncEnabled(): boolean {
  return process.env.ENABLE_AUTO_SYNC !== "false";
}

export async function runBackgroundSync(reason = "scheduled"): Promise<void> {
  if (isSyncInProgress()) {
    console.log(`[scheduler] Background sync triggered (${reason}), but a sync is already running. Skipping...`);
    return;
  }

  console.log(`[scheduler] Starting automatic background Notion sync (${reason})...`);
  try {
    const result = await syncNotionToPostgres({
      embed: process.env.EMBEDDINGS_ENABLED !== "false",
    });
    console.log(
      `[scheduler] Background sync completed successfully (${reason}). Total: ${result.totalPages}, Upserted: ${result.upserted}, Skipped: ${result.skipped}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg !== "Sync already in progress") {
      console.error(`[scheduler] Error during background Notion sync (${reason}):`, error);
    }
  }
}

export function startBackgroundSyncScheduler(): void {
  if (globalForScheduler.schedulerInitialized) {
    return;
  }

  if (!isAutoSyncEnabled()) {
    console.log("[scheduler] Automatic background sync is disabled via ENABLE_AUTO_SYNC=false.");
    return;
  }

  const intervalMs = getSyncIntervalMs();
  const hours = intervalMs / (60 * 60 * 1000);

  globalForScheduler.schedulerInitialized = true;

  console.log(`[scheduler] Background Notion sync scheduler initialized (Running every ${hours} hour(s)).`);

  // Run initial background sync after a short delay on server boot
  setTimeout(() => {
    runBackgroundSync("startup");
  }, 10_000);

  // Schedule recurring sync every 4 hours
  globalForScheduler.syncSchedulerTimer = setInterval(() => {
    runBackgroundSync("interval");
  }, intervalMs);

  // Ensure timer doesn't keep node process alive unnaturally
  if (globalForScheduler.syncSchedulerTimer.unref) {
    globalForScheduler.syncSchedulerTimer.unref();
  }
}
