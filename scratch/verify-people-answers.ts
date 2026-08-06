/**
 * P0-01 People Discovery — Production-Quality End-to-End Verification
 *
 * Validates against the DATABASE (ground truth), not just answer shape.
 *
 * Run: npx tsx scratch/verify-people-answers.ts
 */
import "dotenv/config";
import "../src/lib/dns-hook";
import { resolveQuery, resolveQueryRulesOnly } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";
import { getPeopleDirectory } from "../src/lib/db/team-members";
import { query as dbQuery } from "../src/lib/db";
import regressionCases from "./people-regression.json";

// ─── Results Tracking ───────────────────────────────────────────────────────

type CheckResult = { label: string; ok: boolean; detail?: string };
const results: CheckResult[] = [];
const PASS = "✅";
const FAIL = "❌";

function check(label: string, ok: boolean, detail?: string) {
  results.push({ label, ok, detail });
  if (ok) console.log(`  ${PASS} ${label}`);
  else console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(name: string) {
  console.log(`\n## ${name}\n`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract all **bolded** names from a markdown answer. */
function extractBoldNames(text: string): string[] {
  const matches = [...text.matchAll(/\*\*([^*\n]{2,60})\*\*/g)];
  return matches.map((m) => m[1].trim()).filter(Boolean);
}

/** Parse the people_list answer into a set of returned names. */
function parsePeopleNames(answer: string): Set<string> {
  const bulletMatches = [...answer.matchAll(/^[-*]\s+\*\*([^*\n]+)\*\*/gm)];
  const names = bulletMatches.map((m) => m[1].trim().toLowerCase());
  return new Set(names);
}

/** Extract the number from "## N result(s)" or "## Team Members (N)" patterns. */
function extractCount(text: string): number | null {
  const countMatch = text.match(/\((\d+)\)|(\d+)\s*result/i);
  if (countMatch) return Number(countMatch[1] ?? countMatch[2]);
  return null;
}

/** Determine execution lane for a parsed query. */
function executionLane(kind: string): "sql" | "rag" | "chat" {
  if (kind === "smalltalk") return "chat";
  const SQL_INTENTS = new Set([
    "people_list", "project_most_devs", "assigned_list", "worked_on_list",
    "owner_list", "owner_of", "created_by_of", "created_by_list",
    "project_manager_of", "status_of", "project_eta", "analytics",
    "activity_summary", "team_activity", "team_roster", "blocker_list",
    "assignee_project_check", "person_project_membership",
  ]);
  return SQL_INTENTS.has(kind) ? "sql" : "rag";
}

// ─── Ground Truth Queries ───────────────────────────────────────────────────

/** Count unique owners per project, return top project. */
async function getProjectWithMostDevelopers(): Promise<{
  projectName: string;
  devCount: number;
  top5: Array<{ title: string; dev_count: number }>;
}> {
  const rows = await dbQuery<{ title: string; dev_count: number }>(`
    SELECT coalesce(title, 'Untitled') as title, count(DISTINCT dev) as dev_count
    FROM (
      SELECT title, trim(unnest(string_to_array(owner, ','))) as dev
      FROM notion_pages
      WHERE owner IS NOT NULL AND trim(owner) <> ''
    ) AS devs
    WHERE dev <> '' AND lower(dev) NOT IN ('unknown', 'n/a', 'none', 'tbd', 'unassigned')
    GROUP BY title
    ORDER BY dev_count DESC, title ASC
    LIMIT 5
  `);
  return {
    projectName: rows[0]?.title ?? "(none)",
    devCount: rows[0]?.dev_count ?? 0,
    top5: rows,
  };
}

/** Count total unique people from all owner/creator/editor fields. */
async function getTotalPeopleCount(): Promise<number> {
  const dir = await getPeopleDirectory();
  return dir.length;
}

/** Run the same SQL as handlePeopleList to get canonical data. */
async function getPeopleListDb(): Promise<string[]> {
  const dir = await getPeopleDirectory();
  return dir.map((p) => p.name);
}

// ─── Verify Functions ───────────────────────────────────────────────────────

async function verifyIntent() {
  section("Intent Classification");

  for (const { question, expectedIntent } of regressionCases as Array<{ question: string; expectedIntent: string }>) {
    const parsed = resolveQueryRulesOnly(question);
    const ok = parsed.kind === expectedIntent || (expectedIntent === "unknown" && parsed.kind !== "people_list" && parsed.kind !== "project_most_devs");
    check(
      `"${question}" → ${parsed.kind}`,
      ok,
      ok ? "" : `expected ${expectedIntent}, got ${parsed.kind}`,
    );
  }
}

async function verifyRouting() {
  section("Routing");

  for (const { question, expectedIntent } of regressionCases as Array<{ question: string; expectedIntent: string }>) {
    if (expectedIntent !== "people_list" && expectedIntent !== "project_most_devs") continue;

    const parsed = resolveQueryRulesOnly(question);
    const lane = executionLane(parsed.kind);

    check(
      `"${question}" routed to ${lane} (not RAG)`,
      lane === "sql",
      lane === "rag" ? "RAG leakage detected" : undefined,
    );
  }
}

async function verifyDirectory() {
  section("People Directory");

  const dir = await getPeopleDirectory();

  check("Directory has entries", dir.length > 0, `got ${dir.length} entries`);

  // Deduplication
  const names = dir.map((p) => p.name.toLowerCase());
  const uniqueNames = new Set(names);
  check("No duplicate names in directory", names.length === uniqueNames.size,
    `got ${names.length - uniqueNames.size} duplicates`);

  // Well-formed names
  const cleanNames = dir.filter((p) => p.name.length >= 2);
  check("All names well-formed (length >= 2)", cleanNames.length === dir.length);

  // Proper capitalisation
  const capitalised = dir.filter((p) => p.name[0] === p.name[0].toUpperCase());
  check("All names capitalised", capitalised.length === dir.length);

  // Deduplication of repeated-word names (e.g. "Mahendra Mahendra")
  const noRepeats = dir.every((p) => {
    const parts = p.name.split(" ");
    return parts.length !== 2 || parts[0] !== parts[1];
  });
  check("No repeated-word names (e.g. 'Mahendra Mahendra')", noRepeats);

  // UUID filter
  const uuidNames = dir.filter((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(p.name));
  check("No UUIDs in directory", uuidNames.length === 0,
    uuidNames.length > 0 ? `found: ${uuidNames.map((p) => p.name).join(", ")}` : undefined);

  console.log(`\n  Directory: ${dir.length} people`);
  console.log(`  Sample: ${dir.slice(0, 5).map((p) => p.name).join(", ")}...`);
}

async function verifySqlAnswer() {
  section("SQL Answer Generation");

  // ── people_list ─────────────────────────────────────────────────────────
  const peopleDir = await getPeopleDirectory();

  const peopleAnswer = await handleMetadataQuery({
    kind: "people_list",
    confidence: 0.95,
    source: "regex",
    raw: "List all developers.",
  });

  check("people_list returns non-null answer", peopleAnswer !== null,
    peopleAnswer === null ? "got null" : undefined);
  if (!peopleAnswer) return;

  // Answer completeness — all names present
  const returnedNames = parsePeopleNames(peopleAnswer);
  const expectedNames = new Set(peopleDir.map((p) => p.name.toLowerCase()));
  const missingNames = [...expectedNames].filter((n) => !returnedNames.has(n));
  const extraNames = [...returnedNames].filter((n) => !expectedNames.has(n));

  check("All directory names appear in answer",
    missingNames.length === 0,
    missingNames.length > 0 ? `missing: ${missingNames.slice(0, 5).join(", ")}...` : undefined);
  check("No extra names in answer",
    extraNames.length === 0,
    extraNames.length > 0 ? `extra: ${extraNames.join(", ")}` : undefined);

  // Count accuracy
  const answerCount = extractCount(peopleAnswer);
  check(`Count correct (${peopleDir.length})`,
    answerCount === peopleDir.length,
    answerCount !== null ? `got ${answerCount}, expected ${peopleDir.length}` : "count not parseable");

  // ── project_most_devs ──────────────────────────────────────────────────
  const groundTruth = await getProjectWithMostDevelopers();
  if (groundTruth.devCount > 0) {
    const devsAnswer = await handleMetadataQuery({
      kind: "project_most_devs",
      confidence: 0.95,
      source: "regex",
      raw: "Which project has the most developers?",
    });

    check("project_most_devs returns non-null answer", devsAnswer !== null,
      devsAnswer === null ? "got null" : undefined);
    if (devsAnswer) {
      // Correct project name
      check(`Correct top project: "${groundTruth.projectName}"`,
        devsAnswer.includes(groundTruth.projectName),
        `got different project`);
      // Correct developer count
      check(`Correct developer count: ${groundTruth.devCount}`,
        devsAnswer.includes(String(groundTruth.devCount)),
        `count ${groundTruth.devCount} not found in answer`);

      // Top-5 correctness
      for (const row of groundTruth.top5) {
        check(`Top-5 includes "${row.title}" (${row.dev_count})`,
          devsAnswer.includes(row.title),
          `project "${row.title}" not found in answer`);
      }
    }
  } else {
    check("Project with most devs exists", false, "no projects with owners found");
  }
}

async function verifyCorrectness() {
  section("Correctness (Database Ground Truth)");

  // E2E: Question → SQL → Compare with DB
  const queries = [
    { q: "Who are all developers?", expectedIntent: "people_list" },
    { q: "Which project has the most developers?", expectedIntent: "project_most_devs" },
  ] as const;

  for (const { q, expectedIntent } of queries) {
    const parsed = await resolveQuery(q, [], "Test User");
    check(`"${q}" resolves to ${expectedIntent}`,
      parsed.kind === expectedIntent,
      `got ${parsed.kind}`);

    const answer = await handleMetadataQuery(parsed);
    check(`"${q}" SQL answer exists`, answer !== null,
      answer === null ? "null answer" : undefined);
  }

  // Cross-validate: people_list answer should match getPeopleDirectory()
  const dir = await getPeopleDirectory();
  const peopleAnswer = await handleMetadataQuery({
    kind: "people_list",
    confidence: 0.95,
    source: "regex",
    raw: "List all developers.",
  });

  if (peopleAnswer) {
    const dirCount = dir.length;
    const answerCount = extractCount(peopleAnswer);
    check(
      `Directory count (${dirCount}) matches answer count (${answerCount ?? "?"})`,
      answerCount === dirCount,
      answerCount !== null ? `got ${answerCount} in answer vs ${dirCount} in DB` : "count not parseable",
    );
  }
}

async function verifyNegativeCases() {
  section("Negative Cases");

  const negatives: Array<{ q: string; expectedKind: string }> = [
    { q: "How many astronauts work here?", expectedKind: "smalltalk" },
    { q: "Tell me about Mars colonization", expectedKind: "semantic" },
  ];

  for (const { q, expectedKind } of negatives) {
    const parsed = await resolveQuery(q, [], "Test User");
    check(
      `"${q}" does NOT route to people_list (got ${parsed.kind})`,
      parsed.kind !== "people_list" && parsed.kind !== "project_most_devs",
      `unexpected people_list routing for negative query`,
    );
  }
}

async function verifyPerformance() {
  section("Performance");

  const ITERATIONS = 3;

  // people_list
  const peopleTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await handleMetadataQuery({
      kind: "people_list",
      confidence: 0.95,
      source: "regex",
      raw: "List all developers.",
    });
    peopleTimes.push(performance.now() - start);
  }
  const avgPeople = peopleTimes.reduce((a, b) => a + b, 0) / peopleTimes.length;
  check(`people_list avg ${avgPeople.toFixed(1)}ms`, avgPeople < 200,
    `${avgPeople.toFixed(1)}ms exceeds 200ms budget`);

  // project_most_devs
  const devsTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await handleMetadataQuery({
      kind: "project_most_devs",
      confidence: 0.95,
      source: "regex",
      raw: "Which project has the most developers?",
    });
    devsTimes.push(performance.now() - start);
  }
  const avgDevs = devsTimes.reduce((a, b) => a + b, 0) / devsTimes.length;
  check(`project_most_devs avg ${avgDevs.toFixed(1)}ms`, avgDevs < 200,
    `${avgDevs.toFixed(1)}ms exceeds 200ms budget`);

  // Intent resolution (no LLM)
  const intentTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    for (const q of ["List all developers.", "Who works where?", "Show all team members."]) {
      resolveQueryRulesOnly(q);
    }
    intentTimes.push(performance.now() - start);
  }
  const avgIntent = intentTimes.reduce((a, b) => a + b, 0) / intentTimes.length;
  check(`Intent resolution avg ${(avgIntent / 3).toFixed(1)}ms per query`,
    avgIntent / 3 < 10,
    `${(avgIntent / 3).toFixed(1)}ms per query exceeds 10ms budget`);
}

async function verifyRegression() {
  section("Regression Fixture");

  // Load regression cases from external JSON
  const cases = regressionCases as Array<{ question: string; expectedIntent: string }>;
  check("Regression fixture loaded", cases.length > 0, `got ${cases.length} cases`);

  // Verify all people_list cases produce valid SQL answers
  const peopleCases = cases.filter((c) => c.expectedIntent === "people_list");
  for (const { question } of peopleCases) {
    const parsed = resolveQueryRulesOnly(question);
    const answer = await handleMetadataQuery(parsed);
    check(`[fixture] "${question}" produces SQL answer`,
      answer !== null && answer.length > 50,
      answer === null ? "null answer" : `only ${answer?.length ?? 0} chars`);
  }

  // Verify project_most_devs case
  const devsCase = cases.find((c) => c.expectedIntent === "project_most_devs");
  if (devsCase) {
    const parsed = resolveQueryRulesOnly(devsCase.question);
    const answer = await handleMetadataQuery(parsed);
    check(`[fixture] "${devsCase.question}" produces SQL answer`,
      answer !== null && answer.length > 50,
      answer === null ? "null answer" : `only ${answer?.length ?? 0} chars`);
  }
}

async function verifyEdgeCases() {
  section("Edge Cases");

  // Borderline phrasings that should still work
  const edges: Array<{ q: string; expectedIntent: string }> = [
    { q: "Developers?", expectedIntent: "people_list" },
    { q: "List every developer", expectedIntent: "people_list" },
    { q: "Show engineers", expectedIntent: "people_list" },
    { q: "List engineers", expectedIntent: "people_list" },
  ];

  for (const { q, expectedIntent } of edges) {
    const parsed = resolveQueryRulesOnly(q);
    check(`[edge] "${q}" → ${parsed.kind}`, parsed.kind === expectedIntent,
      `expected ${expectedIntent}, got ${parsed.kind}`);
  }

  // Verify that known-non-people queries don't route to people_list
  const nonPeopleQueries = [
    "Who is in engineering?",
    "Who is in tech?",
    "Software engineers",
    "How many astronauts work here?",
  ];
  for (const q of nonPeopleQueries) {
    const parsed = resolveQueryRulesOnly(q);
    check(`[edge] "${q}" is NOT people_list (got ${parsed.kind})`,
      parsed.kind !== "people_list" && parsed.kind !== "project_most_devs",
      `unexpected people_list routing`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("P0-01 People Discovery — Production Verification Suite");
  console.log("=".repeat(70));

  await verifyDirectory();
  await verifyIntent();
  await verifyEdgeCases();
  await verifyRouting();
  await verifySqlAnswer();
  await verifyCorrectness();
  await verifyNegativeCases();
  await verifyPerformance();
  await verifyRegression();

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
    console.log("All checks passed! ✅");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

