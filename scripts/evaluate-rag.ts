/**
 * scripts/evaluate-rag.ts
 *
 * Full End-to-End RAG Evaluation Benchmark Suite
 * Combines Retrieval Metrics (Recall, Precision, NDCG) and Generation Metrics (Faithfulness).
 *
 * Usage: npm run eval  OR  npx tsx scripts/evaluate-rag.ts
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import path from "node:path";
import { evaluateRetrieval } from "./evaluate-retrieval";
import { evaluateFaithfulness } from "./evaluate-faithfulness";

async function main() {
  const startTime = Date.now();
  console.log("\n=======================================================");
  console.log("🚀 STARTING RAG SYSTEM EVALUATION BENCHMARK SUITE");
  console.log("=======================================================\n");

  const datasetPath = path.join(process.cwd(), "eval", "golden-dataset.json");

  // Step 1: Retrieval Evaluation
  console.log("1️⃣  Evaluating Retrieval Pipeline (Recall@5, Precision@5, NDCG@5)...");
  const retrievalResults = await evaluateRetrieval(datasetPath);

  const avgRecall =
    retrievalResults.reduce((s, r) => s + r.recall, 0) / retrievalResults.length;
  const avgPrecision =
    retrievalResults.reduce((s, r) => s + r.precision, 0) / retrievalResults.length;
  const avgNdcg =
    retrievalResults.reduce((s, r) => s + r.ndcg, 0) / retrievalResults.length;

  console.log("✓ Retrieval evaluation complete.");

  // Step 2: Faithfulness Evaluation (if OpenAI API Key is present)
  let avgFaithfulness = 0;
  let faithfulnessRan = false;

  if (process.env.OPENAI_API_KEY) {
    console.log("\n2️⃣  Evaluating Generation Faithfulness (LLM-as-a-Judge)...");
    const faithfulnessResults = await evaluateFaithfulness(datasetPath);
    avgFaithfulness =
      faithfulnessResults.reduce((s, r) => s + r.faithfulnessScore, 0) /
      (faithfulnessResults.length || 1);
    faithfulnessRan = true;
    console.log("✓ Generation Faithfulness evaluation complete.");
  } else {
    console.log("\n⚠️  Skipping Faithfulness evaluation (OPENAI_API_KEY not set).");
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  // Step 3: Final Benchmark Report
  console.log("\n=======================================================");
  console.log("📊 FINAL RAG EVALUATION BENCHMARK SUMMARY");
  console.log("=======================================================");
  console.log(` Dataset Size:         ${retrievalResults.length} Queries`);
  console.log(` Benchmark Run Time:   ${durationSec}s`);
  console.log("-------------------------------------------------------");
  console.log(` 🔹 Recall@5:           ${(avgRecall * 100).toFixed(1)}%`);
  console.log(` 🔹 Precision@5:        ${(avgPrecision * 100).toFixed(1)}%`);
  console.log(` 🔹 NDCG@5:             ${(avgNdcg * 100).toFixed(1)}%`);
  if (faithfulnessRan) {
    console.log(` 🔹 Faithfulness Score: ${(avgFaithfulness * 100).toFixed(1)}%`);
  }
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error("❌ Evaluation Suite failed:", err);
  process.exit(1);
});
