/**
 * scripts/evaluate-retrieval.ts
 *
 * Runs the golden benchmark dataset against the RAG retriever and computes
 * Recall@K, Precision@K, and NDCG@K metrics.
 *
 * Usage: npx tsx scripts/evaluate-retrieval.ts
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { buildNotionContextWithConfidence } from "../src/lib/rag/build-context";
import { runHybridChunkRetrieval } from "../src/lib/rag/hybrid-search";

interface GoldenItem {
  id: string;
  query: string;
  expected_chunk_ids?: string[];
  expected_page_titles?: string[];
  expected_answer_claims?: string[];
}

export interface RetrievalQueryResult {
  id: string;
  query: string;
  topHitsCount: number;
  topScore: number;
  confidenceOk: boolean;
  recall: number;
  precision: number;
  ndcg: number;
}

const K = 5; // Evaluate top 5 retrieved items

/**
 * Checks if a retrieved hit matches the golden expectations.
 * Matches on exact chunk_id OR page title inclusion.
 */
function isHitRelevant(hit: { chunk_id: string; title: string | null }, golden: GoldenItem): boolean {
  if (golden.expected_chunk_ids?.includes(hit.chunk_id)) {
    return true;
  }
  if (hit.title && golden.expected_page_titles?.length) {
    const titleLower = hit.title.toLowerCase();
    return golden.expected_page_titles.some((expected) =>
      titleLower.includes(expected.toLowerCase()) || expected.toLowerCase().includes(titleLower)
    );
  }
  return false;
}

export function recallAtK(hits: boolean[], totalExpected: number): number {
  if (totalExpected === 0) return 1;
  const matchCount = hits.filter(Boolean).length;
  return Math.min(1, matchCount / totalExpected);
}

export function precisionAtK(hits: boolean[], k: number): number {
  if (k === 0 || hits.length === 0) return 0;
  const matchCount = hits.filter(Boolean).length;
  return matchCount / hits.length;
}

export function ndcgAtK(hits: boolean[], totalExpected: number): number {
  if (hits.length === 0 || totalExpected === 0) return 0;

  // DCG calculation: discount factor log2(rank + 1)
  const dcg = hits.reduce((sum, isRel, i) => {
    const rel = isRel ? 1 : 0;
    const discount = Math.log2(i + 2); // i is 0-indexed, rank is i + 1
    return sum + rel / discount;
  }, 0);

  // Ideal DCG (IDCG): all expected relevant items appear first
  const idealCount = Math.min(hits.length, totalExpected);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export async function evaluateRetrieval(datasetPath?: string) {
  const file = datasetPath || path.join(process.cwd(), "eval", "golden-dataset.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Golden dataset file not found at: ${file}`);
  }

  const dataset: GoldenItem[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  const results: RetrievalQueryResult[] = [];

  for (const item of dataset) {
    let hits: Array<{ chunk_id: string; title: string | null; score: number }> = [];
    let topScore = 0;
    let confidenceOk = false;

    try {
      // Run hybrid retriever
      const hybridRes = await runHybridChunkRetrieval([item.query]);
      hits = hybridRes.rows.slice(0, K).map((r) => ({
        chunk_id: r.chunk_id,
        title: r.title,
        score: r.final_score,
      }));

      const confRes = await buildNotionContextWithConfidence([item.query]);
      topScore = confRes.confidence.topScore;
      confidenceOk = confRes.confidence.ok;
    } catch (err) {
      console.warn(`[eval-retrieval] Warning: error fetching context for "${item.query}":`, err);
    }

    const totalExpected = Math.max(
      item.expected_chunk_ids?.length || 0,
      item.expected_page_titles?.length || 0,
      1
    );

    const relevanceVector = hits.map((hit) => isHitRelevant(hit, item));

    results.push({
      id: item.id,
      query: item.query,
      topHitsCount: hits.length,
      topScore: Number(topScore.toFixed(3)),
      confidenceOk,
      recall: recallAtK(relevanceVector, totalExpected),
      precision: precisionAtK(relevanceVector, K),
      ndcg: ndcgAtK(relevanceVector, totalExpected),
    });
  }

  return results;
}

async function main() {
  console.log("🔍 Running Retrieval Evaluation (Recall@5, Precision@5, NDCG@5)...");
  const results = await evaluateRetrieval();

  console.log("\nPer-Query Retrieval Metrics:");
  console.table(
    results.map((r) => ({
      ID: r.id,
      Query: r.query.length > 40 ? `${r.query.slice(0, 37)}...` : r.query,
      Hits: r.topHitsCount,
      TopScore: r.topScore,
      Confidence: r.confidenceOk ? "PASS" : "FAIL",
      "Recall@5": r.recall.toFixed(2),
      "Precision@5": r.precision.toFixed(2),
      "NDCG@5": r.ndcg.toFixed(2),
    }))
  );

  const avg = (key: "recall" | "precision" | "ndcg") =>
    (results.reduce((sum, r) => sum + r[key], 0) / results.length).toFixed(3);

  console.log("\n==============================================");
  console.log(`📊 AVERAGE RETRIEVAL METRICS (Dataset size: ${results.length})`);
  console.log(`   Recall@${K}:    ${avg("recall")}`);
  console.log(`   Precision@${K}: ${avg("precision")}`);
  console.log(`   NDCG@${K}:      ${avg("ndcg")}`);
  console.log("==============================================\n");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Retrieval evaluation failed:", err);
    process.exit(1);
  });
}
