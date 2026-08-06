/**
 * Intent Regression — Verifies that the parser/routes don't break.
 *
 * Loads all regressions/*-intent.json files and checks that each question
 * produces the expected intent (kind). This suite has zero DB dependencies
 * and can run offline.
 *
 * Run: npx tsx scratch/verify-intents.ts
 */
import { resolveQueryRulesOnly } from "../src/lib/query/resolve-query";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface IntentCase {
  question: string;
  expectedIntent: string;
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const REGRESSIONS_DIR = join(__dirname, "regressions");
const PASS = "✅";
const FAIL = "❌";

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadIntentFiles(): IntentCase[] {
  const files = readdirSync(REGRESSIONS_DIR).filter(
    (f) => f.endsWith("-intent.json") || f.endsWith("intent-regression.json"),
  );

  const cases: IntentCase[] = [];
  for (const file of files) {
    const content = readFileSync(join(REGRESSIONS_DIR, file), "utf-8");
    const parsed = JSON.parse(content) as IntentCase[];
    cases.push(
      ...parsed.map((c) => ({
        ...c,
        _source: file,
      })),
    );
  }

  return cases;
}

/**
 * Determine if two intents match. "unknown" is special — it means the query
 * should NOT route to known SQL intents (people_list / project_most_devs).
 */
function intentMatches(actual: string, expected: string): boolean {
  if (expected === "unknown") {
    // "unknown" means: NOT a known SQL intent (people_list or project_most_devs)
    return actual !== "people_list" && actual !== "project_most_devs";
  }
  return actual === expected;
}

function intentMismatchDetail(actual: string, expected: string): string {
  if (expected === "unknown") {
    return `expected not-people-list/project-most-devs, got ${actual}`;
  }
  return `expected ${expected}, got ${actual}`;
}

// ─── Results ────────────────────────────────────────────────────────────────

const results: CheckResult[] = [];

function check(label: string, ok: boolean, detail?: string) {
  results.push({ label, ok, detail });
  if (ok) console.log(`  ${PASS} ${label}`);
  else console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(name: string) {
  console.log(`\n## ${name}\n`);
}

// ─── Verify Functions ───────────────────────────────────────────────────────

function verifyIntentLoading() {
  section("Data Loading");

  const cases = loadIntentFiles();
  check(
    "Loaded intent regression cases",
    cases.length > 0,
    `got ${cases.length} cases`,
  );

  // Check all cases have required fields
  const valid = cases.every(
    (c) => typeof c.question === "string" && typeof c.expectedIntent === "string",
  );
  check("All cases have question + expectedIntent", valid,
    valid ? "" : "some cases missing required fields");

  return cases;
}

function verifyIntentRegression(cases: IntentCase[]) {
  section("Intent Classification");

  for (const { question, expectedIntent } of cases) {
    const parsed = resolveQueryRulesOnly(question);
    const ok = intentMatches(parsed.kind, expectedIntent);
    check(
      `"${question}" → ${parsed.kind}`,
      ok,
      ok ? "" : intentMismatchDetail(parsed.kind, expectedIntent),
    );
  }
}

function verifyEdgeCases() {
  section("Edge Cases");

  const edges: Array<{
    q: string;
    expectedIntent: string;
    label?: string;
  }> = [
    // Trailing punctuation variations
    { q: "Developers?", expectedIntent: "people_list" },
    { q: "Developers.", expectedIntent: "people_list" },
    { q: "Developers!", expectedIntent: "people_list" },
    { q: "List every developer", expectedIntent: "people_list" },
    { q: "Show engineers", expectedIntent: "people_list" },
    { q: "List engineers", expectedIntent: "people_list" },
    // Short-form
    { q: "Devs?", expectedIntent: "people_list" },
    { q: "Devs", expectedIntent: "people_list" },
    // Display synonym
    { q: "Display all developers", expectedIntent: "people_list" },
    // Get synonym
    { q: "Get all developers", expectedIntent: "people_list" },
    // Count variants
    { q: "Total developers", expectedIntent: "people_list" },
    { q: "Count developers", expectedIntent: "people_list" },
    // Negative — not people queries
    { q: "Who is in engineering?", expectedIntent: "unknown", label: "dept filter" },
    { q: "Who is in tech?", expectedIntent: "unknown", label: "dept filter" },
    { q: "Software engineers", expectedIntent: "unknown", label: "generic role" },
    { q: "How many astronauts work here?", expectedIntent: "unknown", label: "absurd query" },
  ];

  for (const { q, expectedIntent } of edges) {
    const parsed = resolveQueryRulesOnly(q);
    const ok = intentMatches(parsed.kind, expectedIntent);
    const label = `[edge] "${q}" → ${parsed.kind}`;
    check(
      label,
      ok,
      ok ? "" : intentMismatchDetail(parsed.kind, expectedIntent),
    );
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log("=".repeat(70));
  console.log("Intent Regression Suite");
  console.log("=".repeat(70));

  const cases = verifyIntentLoading();
  verifyIntentRegression(cases);
  verifyEdgeCases();

  // ─── Summary ────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log("\n" + "=".repeat(70));
  console.log(`\nResults: ${PASS} ${passed} passed, ${FAIL} ${failed} failed (${total} total)`);
  console.log(`Score: ${(passed / total * 10).toFixed(1)}/10`);
  console.log();

  if (failed > 0) {
    console.log("FAILURES:");
    for (const r of results) {
      if (!r.ok) console.log(`  ${FAIL} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exit(1);
  } else {
    console.log("All intent checks passed! ✅");
  }
}

main();

