/**
 * scripts/evaluate-faithfulness.ts
 *
 * Uses an LLM-as-a-judge module to evaluate RAG Generation Faithfulness.
 * Deconstructs generated answers into factual statements and verifies whether
 * each statement is strictly supported by the retrieved context.
 *
 * Usage: npx tsx scripts/evaluate-faithfulness.ts
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { buildNotionContextWithConfidence } from "../src/lib/rag/build-context";
import { getChatResponse, getJsonCompletion } from "../src/lib/ai/openai";

interface GoldenItem {
  id: string;
  query: string;
  expected_chunk_ids?: string[];
  expected_page_titles?: string[];
  expected_answer_claims?: string[];
}

export interface FaithfulnessClaim {
  statement: string;
  supported: boolean;
  reasoning: string;
}

export interface FaithfulnessQueryResult {
  id: string;
  query: string;
  generatedAnswer: string;
  totalClaims: number;
  supportedClaims: number;
  faithfulnessScore: number;
  claims: FaithfulnessClaim[];
}

const FAITHFULNESS_JUDGE_SYSTEM_PROMPT = `
You are an expert RAG Evaluator & Fact Verification System.
Your task is to judge whether a generated Assistant response is strictly faithful to the provided Retrieved Context.

INSTRUCTIONS:
1. Break down the Assistant Response into individual, verifiable factual claims.
2. For each claim, determine if it is directly supported by the provided Retrieved Context (Supported: true or false).
3. If context is missing or if the claim contains information not present in the context, set supported to false.
4. Return a JSON object in this format:
{
  "claims": [
    {
      "statement": "Claim text here",
      "supported": true,
      "reasoning": "Reason why context supports or does not support this claim."
    }
  ]
}
`;

export async function evaluateFaithfulness(datasetPath?: string) {
  const file = datasetPath || path.join(process.cwd(), "eval", "golden-dataset.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Golden dataset file not found at: ${file}`);
  }

  const dataset: GoldenItem[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  const results: FaithfulnessQueryResult[] = [];

  for (const item of dataset) {
    try {
      // 1. Fetch retrieval context
      const { context } = await buildNotionContextWithConfidence([item.query]);

      if (!context.trim()) {
        results.push({
          id: item.id,
          query: item.query,
          generatedAnswer: "No context retrieved",
          totalClaims: 0,
          supportedClaims: 0,
          faithfulnessScore: 0,
          claims: [],
        });
        continue;
      }

      // 2. Generate answer using RAG pipeline prompt logic
      const generatedAnswer = await getChatResponse(item.query, context);

      // 3. Evaluate Faithfulness using LLM-as-a-judge
      const judgePrompt = `
Retrieved Context:
---
${context}
---

Assistant Response:
---
${generatedAnswer}
---
`;

      const jsonStr = await getJsonCompletion(FAITHFULNESS_JUDGE_SYSTEM_PROMPT, judgePrompt);
      const parsed = JSON.parse(jsonStr) as { claims?: FaithfulnessClaim[] };
      const claims = parsed.claims || [];

      const totalClaims = claims.length;
      const supportedClaims = claims.filter((c) => c.supported).length;
      const faithfulnessScore = totalClaims > 0 ? supportedClaims / totalClaims : 1.0;

      results.push({
        id: item.id,
        query: item.query,
        generatedAnswer,
        totalClaims,
        supportedClaims,
        faithfulnessScore: Number(faithfulnessScore.toFixed(3)),
        claims,
      });
    } catch (err) {
      console.warn(`[eval-faithfulness] Failed for query "${item.query}":`, err);
      results.push({
        id: item.id,
        query: item.query,
        generatedAnswer: "Evaluation Error",
        totalClaims: 0,
        supportedClaims: 0,
        faithfulnessScore: 0,
        claims: [],
      });
    }
  }

  return results;
}

async function main() {
  console.log("⚖️  Running Generation Faithfulness Evaluation (LLM-as-a-Judge)...");
  const results = await evaluateFaithfulness();

  console.log("\nPer-Query Faithfulness Metrics:");
  console.table(
    results.map((r) => ({
      ID: r.id,
      Query: r.query.length > 35 ? `${r.query.slice(0, 32)}...` : r.query,
      Claims: `${r.supportedClaims}/${r.totalClaims}`,
      Faithfulness: `${(r.faithfulnessScore * 100).toFixed(1)}%`,
    }))
  );

  const avgScore =
    results.reduce((sum, r) => sum + r.faithfulnessScore, 0) / (results.length || 1);

  console.log("\n==============================================");
  console.log(`📊 AVERAGE GENERATION FAITHFULNESS: ${(avgScore * 100).toFixed(1)}%`);
  console.log("==============================================\n");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Faithfulness evaluation failed:", err);
    process.exit(1);
  });
}
