export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundSyncScheduler } = await import("@/lib/ingestion/scheduler");
    startBackgroundSyncScheduler();
  }
}
