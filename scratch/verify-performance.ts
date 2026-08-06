/**
 * Performance Regression — Ensures SQL answers and intent resolution
 * stay within budget.
 *
 * Run: npx tsx scratch/verify-performance.ts
 */
import "dotenv/config";
import "../src/lib/dns-hook";
import { resolveQueryRulesOnly } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";

// ─── Config ─────────────────────────────────────────────────────────────────

const PASS = "✅";
const FAIL = "❌";
const ITERATIONS = 3;

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(label: string, ok: boolean, detail?: string) {
  results.push({ label, ok, detail });
  if (ok) console.log(`  ${PASS} ${label}`);
  else console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(name: string) {
  console.log(`\n## ${name}\n`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function measure<T>(fn: () => Promise<T>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ─── Verify Functions ───────────────────────────────────────────────────────

async function verifySqlPerformance() {
  section("SQL Answer Generation");

  // people_list
  const peopleTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    peopleTimes.push(
      await measure(() =>
        handleMetadataQuery({
          kind: "people_list",
          confidence: 0.95,
          source: "regex",
          raw: "List all developers.",
        }),
      ),
    );
  }
  const avgPeople = peopleTimes.reduce((a, b) => a + b, 0) / peopleTimes.length;
  check(
    `people_list avg ${avgPeople.toFixed(1)}ms`,
    avgPeople < 1000,
    `${avgPeople.toFixed(1)}ms exceeds 1s budget`,
  );

  // project_most_devs
  const devsTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    devsTimes.push(
      await measure(() =>
        handleMetadataQuery({
          kind: "project_most_devs",
          confidence: 0.95,
          source: "regex",
          raw: "Which project has the most developers?",
        }),
      ),
    );
  }
  const avgDevs = devsTimes.reduce((a, b) => a + b, 0) / devsTimes.length;
  check(
    `project_most_devs avg ${avgDevs.toFixed(1)}ms`,
    avgDevs < 1000,
    `${avgDevs.toFixed(1)}ms exceeds 1s budget`,
  );
}

function verifyIntentPerformance() {
  section("Intent Resolution (no LLM)");

  const querySet = [
    "List all developers.",
    "Who works where?",
    "Show all team members.",
    "Which project has the most developers?",
    "Developers?",
  ];

  const intentTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    for (const q of querySet) {
      resolveQueryRulesOnly(q);
    }
    intentTimes.push(performance.now() - start);
  }

  const avgTotal = intentTimes.reduce((a, b) => a + b, 0) / intentTimes.length;
  const avgPerQuery = avgTotal / querySet.length;

  check(
    `Intent resolution avg ${avgPerQuery.toFixed(1)}ms per query (${querySet.length} queries × ${ITERATIONS} iterations)`,
    avgPerQuery < 10,
    `${avgPerQuery.toFixed(1)}ms per query exceeds 10ms budget`,
  );
}

async function verifyCachePerformance() {
  section("Cache Performance (Second Call)");

  // First call populates cache
  await handleMetadataQuery({
    kind: "people_list",
    confidence: 0.95,
    source: "regex",
    raw: "List all developers.",
  });

  // Second call should be faster
  const cachedTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    cachedTimes.push(
      await measure(() =>
        handleMetadataQuery({
          kind: "people_list",
          confidence: 0.95,
          source: "regex",
          raw: "List all developers.",
        }),
      ),
    );
  }
  const avgCached = cachedTimes.reduce((a, b) => a + b, 0) / cachedTimes.length;
  check(
    `Cached people_list avg ${avgCached.toFixed(1)}ms`,
    avgCached < 10,
    `${avgCached.toFixed(1)}ms — cache may not be working`,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("Performance Regression Suite");
  console.log("=".repeat(70));

  verifyIntentPerformance();
  await verifySqlPerformance();
  await verifyCachePerformance();

  // ─── Summary ────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log("\n" + "=".repeat(70));
  console.log(
    `\nResults: ${PASS} ${passed} passed, ${FAIL} ${failed} failed (${total} total)`,
  );
  console.log(`Score: ${(passed / total * 10).toFixed(1)}/10`);
  console.log();

  if (failed > 0) {
    console.log("FAILURES:");
    for (const r of results) {
      if (!r.ok)
        console.log(`  ${FAIL} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exit(1);
  } else {
    console.log("All performance checks passed! ✅");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

