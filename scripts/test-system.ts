/**
 * System test script — tests all layers end-to-end
 * Run: npx tsx scripts/test-system.ts
 */

import "dotenv/config";
import { parseQuery } from "../src/lib/query-router";
import { handleMetadataQuery } from "../src/lib/metadata-search";
import { semanticSearch } from "../src/lib/vector-search";
import { getPool } from "../src/lib/postgres";

type TestResult = {
  id: number;
  question: string;
  expectedRoute: string;
  actualRoute: string;
  answer: string;
  passed: boolean;
  durationMs: number;
  notes?: string;
};

const TESTS: { id: number; question: string; expectedRoute: string; expectContains?: string; expectNotContains?: string }[] = [
  // --- PostgreSQL: owner_list
  { id: 1, question: "Show me all docs owned by Piyush Kalra", expectedRoute: "owner_list", expectContains: "Piyush Kalra" },
  { id: 2, question: "Which docs have Pooja Bakhtani as owner?", expectedRoute: "owner_list", expectContains: "Pooja Bakhtani" },

  // --- PostgreSQL: owner_of
  { id: 3, question: "Who is the owner of Resume Prompt Final tracker?", expectedRoute: "owner_of", expectContains: "Roshni" },
  { id: 3.1, question: "Who owns the Zuvy doc?", expectedRoute: "owner_of", expectContains: "Nilesh" } as any,

  // --- PostgreSQL: created_by_of
  { id: 4, question: "Who created the AI Open House page?", expectedRoute: "created_by_of", expectContains: "Piyush" },

  // --- PostgreSQL: created_by_list
  { id: 5, question: "Show all docs created by Saksham Chauhan", expectedRoute: "created_by_list", expectContains: "Saksham" },

  // --- PostgreSQL: type_of
  { id: 6, question: "What type is the Build with AI doc?", expectedRoute: "type_of" },

  // --- PostgreSQL: status_of
  { id: 7, question: "What is the status of Zuvy?", expectedRoute: "status_of" },

  // --- PostgreSQL: topic_list
  { id: 8, question: "Show me all Zuvy related data", expectedRoute: "topic_list", expectContains: "Zuvy" },
  { id: 9, question: "All docs related to PDLD", expectedRoute: "topic_list", expectContains: "PDLD" },

  // --- PostgreSQL: worked_on_list
  { id: 10, question: "Which tasks did Piyush Kalra work on?", expectedRoute: "worked_on_list", expectContains: "Piyush" },

  // --- Semantic: DeepSeek
  { id: 11, question: "What is NavGurukul's mission?", expectedRoute: "semantic" },
  { id: 12, question: "Summarize the Services Cooperative document", expectedRoute: "semantic" },

  // --- Edge: not found
  { id: 13, question: "Who owns XYZ fake document that doesnt exist?", expectedRoute: "owner_of", expectContains: "couldn't find", expectNotContains: "does not exist" },
  { id: 14, question: "Show all docs owned by Batman", expectedRoute: "owner_list", expectContains: "couldn't find", expectNotContains: "does not exist" },
];

async function runTest(test: typeof TESTS[0]): Promise<TestResult> {
  const start = Date.now();
  const parsed = parseQuery(test.question);
  const actualRoute = parsed.kind;

  let answer = "";

  try {
    if (parsed.kind !== "semantic") {
      const direct = await handleMetadataQuery(parsed);
      answer = direct ?? "(metadata handler returned null — fell through to semantic)";
      if (!direct) {
        // fell through
        answer = await semanticSearch(test.question);
      }
    } else {
      answer = await semanticSearch(test.question);
    }
  } catch (err) {
    answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  const durationMs = Date.now() - start;

  let passed = actualRoute === test.expectedRoute;
  const notes: string[] = [];

  if (test.expectContains && !answer.toLowerCase().includes(test.expectContains.toLowerCase())) {
    passed = false;
    notes.push(`Expected answer to contain "${test.expectContains}"`);
  }
  if (test.expectNotContains && answer.toLowerCase().includes(test.expectNotContains.toLowerCase())) {
    passed = false;
    notes.push(`Answer should NOT contain "${test.expectNotContains}"`);
  }
  if (answer.startsWith("ERROR:")) {
    passed = false;
    notes.push(answer);
  }

  return {
    id: test.id,
    question: test.question,
    expectedRoute: test.expectedRoute,
    actualRoute,
    answer: answer.slice(0, 300) + (answer.length > 300 ? "..." : ""),
    passed,
    durationMs,
    notes: notes.join("; ") || undefined,
  };
}

async function main() {
  console.log("\n=== NOTION CHATBOT — SYSTEM TEST REPORT ===\n");
  console.log(`Running ${TESTS.length} tests...\n`);

  const results: TestResult[] = [];

  for (const test of TESTS) {
    process.stdout.write(`[${test.id}] ${test.question.slice(0, 60)}... `);
    const result = await runTest(test);
    results.push(result);
    console.log(result.passed ? "✅ PASS" : "❌ FAIL");
    if (!result.passed && result.notes) {
      console.log(`    ↳ ${result.notes}`);
    }
    console.log(`    Route: ${result.expectedRoute} → ${result.actualRoute} | ${result.durationMs}ms`);
    console.log(`    Answer: ${result.answer.slice(0, 150).replace(/\n/g, " ")}`);
    console.log();
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("=== SUMMARY ===");
  console.log(`Total: ${results.length} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);
  console.log();

  if (failed > 0) {
    console.log("Failed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  [${r.id}] ${r.question}`);
      if (r.notes) console.log(`       ${r.notes}`);
    });
  }

  await getPool().end();
}

main().catch(console.error);
