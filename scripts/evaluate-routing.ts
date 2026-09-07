/**
 * scripts/evaluate-routing.ts
 *
 * Routing Evaluation Benchmark
 * Measures intent classification accuracy, execution path selection, LLM classifier call frequency,
 * and decision latency for resolveQuery().
 *
 * Schema: Query | Expected Route | Actual Route | Correct? | LLM Used? | Latency
 *
 * Usage: npx tsx scripts/evaluate-routing.ts
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import { resolveQuery } from "../src/lib/query/resolve-query";

interface RoutingTestCase {
  query: string;
  expectedRoute: string; // e.g. 'smalltalk', 'semantic', 'worked_on_list', 'team_roster', 'owner_of', 'page_about', 'project_summary'
  description: string;
}

const TEST_CASES: RoutingTestCase[] = [
  // 1. Fast-Path / Smalltalk
  { query: "hi", expectedRoute: "smalltalk", description: "Greeting fast-path" },
  { query: "good morning", expectedRoute: "smalltalk", description: "Greeting morning" },
  { query: "thank you so much", expectedRoute: "smalltalk", description: "Thanks expression" },

  // 2. Notion Link Requests
  { query: "link for Employee Onboarding", expectedRoute: "semantic", description: "Notion link query" },
  { query: "notion url for Engineering Handbook", expectedRoute: "semantic", description: "Notion URL query" },

  // 3. Structured SQL Queries - Activity
  { query: "What did Rahul work on?", expectedRoute: "worked_on_list", description: "Person activity summary" },
  { query: "Show recent activity for Priya", expectedRoute: "worked_on_list", description: "Person recent activity" },

  // 4. Structured SQL Queries - Roster / Team
  { query: "Who is working on Project Apollo?", expectedRoute: "team_roster", description: "Project team members" },
  { query: "List team members for Onboarding", expectedRoute: "team_roster", description: "Team roster query" },

  // 5. Structured SQL Queries - Ownership
  { query: "Who is the owner of the Architecture Spec?", expectedRoute: "owner_of", description: "Document owner query" },

  // 6. Ambiguous Query Boundary Tests
  { query: "Tell me about Employee Onboarding", expectedRoute: "page_about", description: "Ambiguous query -> page_about / RAG" },
  { query: "Who is associated with Employee Onboarding?", expectedRoute: "team_roster", description: "Ambiguous query -> team_roster / SQL" },
  { query: "Give me everything about Employee Onboarding", expectedRoute: "project_summary", description: "Ambiguous query -> project_summary / RAG" },

  // 7. RAG Knowledge Queries
  { query: "What is our remote work policy?", expectedRoute: "semantic", description: "Unstructured policy RAG query" },
  { query: "Explain how the sync worker processes Notion blocks", expectedRoute: "semantic", description: "Technical architecture RAG query" },
  { query: "How do we deploy the application to AWS?", expectedRoute: "semantic", description: "Deployment guide RAG query" },
];

async function runRoutingEvaluation() {
  console.log("⚡ Running Intent Routing Benchmark (resolveQuery)...\n");

  let correctCount = 0;
  let llmCallCount = 0;
  let totalLatencyMs = 0;

  const tableOutput: Array<{
    Query: string;
    "Expected Route": string;
    "Actual Route": string;
    "Correct?": string;
    "LLM Used?": string;
    Latency: string;
  }> = [];

  for (const tc of TEST_CASES) {
    const t0 = performance.now();
    const parsed = await resolveQuery(tc.query);
    const duration = performance.now() - t0;
    totalLatencyMs += duration;

    const usedLlm = parsed.source !== "regex";
    if (usedLlm) llmCallCount++;

    const isCorrect = parsed.kind === tc.expectedRoute;
    if (isCorrect) correctCount++;

    tableOutput.push({
      Query: tc.query.length > 35 ? `${tc.query.slice(0, 32)}...` : tc.query,
      "Expected Route": tc.expectedRoute,
      "Actual Route": parsed.kind,
      "Correct?": isCorrect ? "✓ PASS" : "❌ FAIL",
      "LLM Used?": usedLlm ? "Yes" : "No",
      Latency: `${duration.toFixed(1)}ms`,
    });
  }

  console.table(tableOutput);

  const accuracyPct = ((correctCount / TEST_CASES.length) * 100).toFixed(1);
  const regexBypassPct = (((TEST_CASES.length - llmCallCount) / TEST_CASES.length) * 100).toFixed(1);
  const avgLatency = (totalLatencyMs / TEST_CASES.length).toFixed(1);

  console.log("==========================================================================");
  console.log("📊 ROUTING BENCHMARK RESULTS");
  console.log(`   Total Queries Tested:      ${TEST_CASES.length}`);
  console.log(`   Classification Accuracy:   ${accuracyPct}% (${correctCount}/${TEST_CASES.length})`);
  console.log(`   Fast Regex Rule Bypass:    ${regexBypassPct}% (${TEST_CASES.length - llmCallCount}/${TEST_CASES.length} queries resolved without LLM)`);
  console.log(`   Average Decision Latency:  ${avgLatency} ms`);
  console.log("==========================================================================\n");
}

runRoutingEvaluation().catch((err) => {
  console.error("❌ Routing evaluation error:", err);
  process.exit(1);
});
