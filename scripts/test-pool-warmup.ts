import "dotenv/config";
import { pool } from "../src/lib/db/postgres";

function ms(n: number) {
  return `${n.toFixed(0)}ms`;
}

async function waitForIdleConnection(timeoutMs: number) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (pool.idleCount >= 1) {
      return performance.now() - start;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return -1; // never became idle within timeout
}

async function main() {
  console.log("Process started. If the fix is present, a warm-up query fired in the background just now.");
  console.log(`pool.totalCount right after import: ${pool.totalCount}, idleCount: ${pool.idleCount}\n`);

  const waited = await waitForIdleConnection(10_000);
  if (waited < 0) {
    console.log("No idle connection appeared within 10s — warm-up either isn't present or is failing.\n");
  } else {
    console.log(`Warm-up connection became idle after ${ms(waited)} — this is your real Neon handshake cost, paid up front.\n`);
  }

  console.log(`pool.totalCount before real query: ${pool.totalCount}, idleCount: ${pool.idleCount}`);

  const start = performance.now();
  await pool.query("SELECT 1");
  console.log(`[first real query] took ${ms(performance.now() - start)}`);
  console.log(`pool.totalCount after real query: ${pool.totalCount} (should still be 1 if it reused the warm connection)`);

  await pool.end();
}

main().catch((err) => {
  console.error("[test-pool-warmup] failed:", err);
  process.exit(1);
});