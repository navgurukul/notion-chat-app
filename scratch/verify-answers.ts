/**
 * Answer Regression — Verifies SQL answer quality against database ground truth.
 *
 * Loads all regressions/*-answers.json files and runs named checks against
 * the answers produced by handleMetadataQuery(). Requires DB connection.
 *
 * Run: npx tsx scratch/verify-answers.ts
 */
import "dotenv/config";
import "../src/lib/dns-hook";
import { resolveQueryRulesOnly } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";
import { getPeopleDirectory } from "../src/lib/db/team-members";
import { query as dbQuery } from "../src/lib/db";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AnswerCase {
  question: string;
  checks: string[];
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

function loadAnswerFiles(): AnswerCase[] {
  const files = readdirSync(REGRESSIONS_DIR).filter(
    (f) => f.endsWith("-answers.json") || f.endsWith("answer-regression.json"),
  );

  const cases: AnswerCase[] = [];
  for (const file of files) {
    const content = readFileSync(join(REGRESSIONS_DIR, file), "utf-8");
    const parsed = JSON.parse(content) as AnswerCase[];
    cases.push(...parsed.map((c) => ({ ...c, _source: file })));
  }

  return cases;
}

/** Parse "## N result(s)" or "## Team Members (N)" patterns. */
function extractCount(text: string): number | null {
  const parenMatch = text.match(/\((\d+)\)/);
  if (parenMatch) return Number(parenMatch[1]);

  const resultMatch = text.match(/(\d+)\s*result/i);
  if (resultMatch) return Number(resultMatch[1]);

  return null;
}

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

// ─── Ground Truth Queries ───────────────────────────────────────────────────

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

// ─── Check Implementations ──────────────────────────────────────────────────

type CheckFn = (
  answer: string,
  question: string,
) => Promise<{ ok: boolean; detail?: string }>;

const CHECK_REGISTRY: Record<string, CheckFn> = {
  nonEmpty: async (answer: string) => ({
    ok: answer !== null && answer.length > 50,
    detail: answer === null
      ? "null answer"
      : `only ${answer?.length ?? 0} chars`,
  }),

  containsPeopleCount: async (answer: string) => {
    const count = extractCount(answer);
    return {
      ok: count !== null && count > 0,
      detail: count === null ? "count not parseable" : `got count ${count}`,
    };
  },

  containsAllPeople: async (answer: string) => {
    const dir = await getPeopleDirectory();
    const returnedNames = parsePeopleNames(answer);
    const expectedNames = new Set(dir.map((p) => p.name.toLowerCase()));

    const missing = [...expectedNames].filter((n) => !returnedNames.has(n));
    const extra = [...returnedNames].filter((n) => !expectedNames.has(n));

    if (missing.length > 0) {
      return {
        ok: false,
        detail: `missing ${missing.length} names (e.g. ${missing.slice(0, 3).join(", ")})`,
      };
    }
    if (extra.length > 0) {
      return {
        ok: false,
        detail: `extra ${extra.length} names (${extra.slice(0, 3).join(", ")})`,
      };
    }
    return { ok: true };
  },

  containsProject: async (answer: string, question: string) => {
    const groundTruth = await getProjectWithMostDevelopers();
    if (groundTruth.devCount === 0) {
      return { ok: false, detail: "no projects with owners found in DB" };
    }
    return {
      ok: answer.includes(groundTruth.projectName),
      detail: `expected project "${groundTruth.projectName}" not found in answer`,
    };
  },

  containsDeveloperCount: async (answer: string, question: string) => {
    const groundTruth = await getProjectWithMostDevelopers();
    if (groundTruth.devCount === 0) {
      return { ok: false, detail: "no projects with owners found in DB" };
    }
    return {
      ok: answer.includes(String(groundTruth.devCount)),
      detail: `expected count ${groundTruth.devCount} not found in answer`,
    };
  },
};

// ─── Verify Functions ───────────────────────────────────────────────────────

async function verifyAnswerLoading(): Promise<AnswerCase[]> {
  section("Data Loading");

  const cases = loadAnswerFiles();
  check(
    "Loaded answer regression cases",
    cases.length > 0,
    `got ${cases.length} cases`,
  );

  const valid = cases.every(
    (c) => typeof c.question === "string" && Array.isArray(c.checks) && c.checks.length > 0,
  );
  check(
    "All cases have question + checks",
    valid,
    valid ? "" : "some cases missing required fields",
  );

  return cases;
}

async function verifyAnswerRegression(cases: AnswerCase[]) {
  section("Answer Checks");

  for (const { question, checks } of cases) {
    // Resolve intent
    const parsed = resolveQueryRulesOnly(question);

    // Get SQL answer
    const answer = await handleMetadataQuery(parsed);

    // Run each check
    for (const checkName of checks) {
      const checkFn = CHECK_REGISTRY[checkName];
      if (!checkFn) {
        check(
          `[${checkName}] "${question}" → unknown check`,
          false,
          `no such check: "${checkName}"`,
        );
        continue;
      }

      const result = await checkFn(answer ?? "", question);
      check(
        `[${checkName}] "${question}"`,
        result.ok,
        result.detail,
      );
    }
  }
}

async function verifyDirectory() {
  section("People Directory");

  const dir = await getPeopleDirectory();

  check("Directory has entries", dir.length > 0, `got ${dir.length} entries`);

  // Deduplication
  const names = dir.map((p) => p.name.toLowerCase());
  const uniqueNames = new Set(names);
  check(
    "No duplicate names in directory",
    names.length === uniqueNames.size,
    `got ${names.length - uniqueNames.size} duplicates`,
  );

  // Well-formed names
  const cleanNames = dir.filter((p) => p.name.length >= 2);
  check(
    "All names well-formed (length >= 2)",
    cleanNames.length === dir.length,
  );

  // Proper capitalisation
  const capitalised = dir.filter((p) => p.name[0] === p.name[0].toUpperCase());
  check(
    "All names capitalised",
    capitalised.length === dir.length,
  );

  // No repeated-word names (e.g. "Mahendra Mahendra")
  const noRepeats = dir.every((p) => {
    const parts = p.name.split(" ");
    return parts.length !== 2 || parts[0] !== parts[1];
  });
  check("No repeated-word names", noRepeats);

  // UUID filter
  const uuidNames = dir.filter((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(p.name));
  check(
    "No UUIDs in directory",
    uuidNames.length === 0,
    uuidNames.length > 0
      ? `found: ${uuidNames.map((p) => p.name).join(", ")}`
      : undefined,
  );
}

async function verifyCorrectness() {
  section("Correctness (Database Ground Truth)");

  // Cross-validate: people_list answer count should match getPeopleDirectory()
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
      answerCount !== null
        ? `got ${answerCount} in answer vs ${dirCount} in DB`
        : "count not parseable",
    );
  }

  // Cross-validate: project_most_devs
  const groundTruth = await getProjectWithMostDevelopers();
  if (groundTruth.devCount > 0) {
    const devsAnswer = await handleMetadataQuery({
      kind: "project_most_devs",
      confidence: 0.95,
      source: "regex",
      raw: "Which project has the most developers?",
    });

    if (devsAnswer) {
      check(
        `Correct top project: "${groundTruth.projectName}"`,
        devsAnswer.includes(groundTruth.projectName),
        `got different project`,
      );
      check(
        `Correct developer count: ${groundTruth.devCount}`,
        devsAnswer.includes(String(groundTruth.devCount)),
        `count ${groundTruth.devCount} not found in answer`,
      );
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(70));
  console.log("Answer Regression Suite");
  console.log("=".repeat(70));

  await verifyDirectory();
  const cases = await verifyAnswerLoading();
  await verifyAnswerRegression(cases);
  await verifyCorrectness();

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
    console.log("All answer checks passed! ✅");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

