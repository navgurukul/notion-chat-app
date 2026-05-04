import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import "dotenv/config";
import { retrieveNotionContextWithMetadata } from "../src/lib/aws";
import { buildContextualSearchQuery, sanitizeChatHistory } from "../src/lib/chat";
import { ChatHistoryItem, getChatResponse } from "../src/lib/gemini";

type BenchmarkCase = {
  id: string;
  category: string;
  question: string;
  history?: ChatHistoryItem[];
  expectedBehavior?: "answer_or_explain_incomplete" | "insufficient_context";
  mustIncludeAny?: string[];
  mustIncludeAll?: string[];
  mustNotInclude?: string[];
  notes?: string;
};

type BenchmarkResult = {
  id: string;
  category: string;
  passed: boolean;
  score: number;
  latencyMs: number;
  retrieval: {
    chunkCount: number;
    sourceCount: number;
    retrievalQueryCount: number;
    contextLength: number;
  };
  tokens: {
    estimatedInput: number;
    estimatedOutput: number;
    estimatedTotal: number;
  };
  costUsd: {
    estimatedGeminiInput: number;
    estimatedGeminiOutput: number;
    estimatedGeminiTotal: number;
  };
  checks: string[];
  question: string;
  answer: string;
  notes?: string;
  error?: string;
};

const DEFAULT_BENCHMARK_FILE = "benchmarks/chatbot-benchmark.json";
const DEFAULT_OUTPUT_DIR = "benchmark-results";
const GEMINI_FLASH_INPUT_PER_MILLION = Number(process.env.GEMINI_FLASH_INPUT_PER_MILLION_USD || 0.3);
const GEMINI_FLASH_OUTPUT_PER_MILLION = Number(process.env.GEMINI_FLASH_OUTPUT_PER_MILLION_USD || 2.5);

function includesIgnoreCase(text: string, pattern: string) {
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function runChecks(test: BenchmarkCase, answer: string) {
  const checks: string[] = [];
  let passedChecks = 0;
  let totalChecks = 0;

  if (test.mustIncludeAll?.length) {
    totalChecks += test.mustIncludeAll.length;
    for (const term of test.mustIncludeAll) {
      const passed = includesIgnoreCase(answer, term);
      if (passed) passedChecks++;
      checks.push(`${passed ? "PASS" : "FAIL"} must include "${term}"`);
    }
  }

  if (test.mustIncludeAny?.length) {
    totalChecks++;
    const matched = test.mustIncludeAny.filter((term) => includesIgnoreCase(answer, term));
    const passed = matched.length > 0;
    if (passed) passedChecks++;
    checks.push(`${passed ? "PASS" : "FAIL"} must include any of: ${test.mustIncludeAny.join(", ")}`);
  }

  if (test.mustNotInclude?.length) {
    totalChecks += test.mustNotInclude.length;
    for (const term of test.mustNotInclude) {
      const passed = !includesIgnoreCase(answer, term);
      if (passed) passedChecks++;
      checks.push(`${passed ? "PASS" : "FAIL"} must not include "${term}"`);
    }
  }

  if (test.expectedBehavior === "insufficient_context") {
    totalChecks++;
    const passed = /not enough|not in (the )?context|do not know|don't know|missing|incomplete|cannot determine|no specific|none (of them )?mention|not mention|different project/i.test(answer);
    if (passed) passedChecks++;
    checks.push(`${passed ? "PASS" : "FAIL"} should admit insufficient context`);
  }

  if (totalChecks === 0) {
    return { passed: true, score: 1, checks: ["PASS no automated checks configured"] };
  }

  return {
    passed: passedChecks === totalChecks,
    score: passedChecks / totalChecks,
    checks,
  };
}

async function main() {
  const benchmarkFile = process.argv[2] || DEFAULT_BENCHMARK_FILE;
  const outputDir = process.env.BENCHMARK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  const raw = await fs.readFile(benchmarkFile, "utf8");
  const tests = JSON.parse(raw) as BenchmarkCase[];
  const results: BenchmarkResult[] = [];

  for (const test of tests) {
    const startedAt = performance.now();
    try {
      const history = sanitizeChatHistory(test.history || []);
      const searchQuery = buildContextualSearchQuery(test.question, history);
      const retrieval = await retrieveNotionContextWithMetadata(searchQuery);
      const answer = await getChatResponse(test.question, retrieval.context, history);
      const latencyMs = Math.round(performance.now() - startedAt);
      const inputTokens = estimateTokens(`${searchQuery}\n${retrieval.context}\n${JSON.stringify(history)}`);
      const outputTokens = estimateTokens(answer);
      const checkResult = runChecks(test, answer);

      results.push({
        id: test.id,
        category: test.category,
        passed: checkResult.passed,
        score: Number(checkResult.score.toFixed(2)),
        latencyMs,
        retrieval: {
          chunkCount: retrieval.chunkCount,
          sourceCount: retrieval.sourceCount,
          retrievalQueryCount: retrieval.retrievalQueryCount,
          contextLength: retrieval.context.length,
        },
        tokens: {
          estimatedInput: inputTokens,
          estimatedOutput: outputTokens,
          estimatedTotal: inputTokens + outputTokens,
        },
        costUsd: {
          estimatedGeminiInput: Number(((inputTokens / 1_000_000) * GEMINI_FLASH_INPUT_PER_MILLION).toFixed(6)),
          estimatedGeminiOutput: Number(((outputTokens / 1_000_000) * GEMINI_FLASH_OUTPUT_PER_MILLION).toFixed(6)),
          estimatedGeminiTotal: Number(
            (
              (inputTokens / 1_000_000) * GEMINI_FLASH_INPUT_PER_MILLION +
              (outputTokens / 1_000_000) * GEMINI_FLASH_OUTPUT_PER_MILLION
            ).toFixed(6),
          ),
        },
        checks: checkResult.checks,
        question: test.question,
        answer,
        notes: test.notes,
      });

      console.log(
        `${checkResult.passed ? "PASS" : "FAIL"} ${test.id} (${test.category}) - ${latencyMs}ms, ${retrieval.chunkCount} chunks`,
      );
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: test.id,
        category: test.category,
        passed: false,
        score: 0,
        latencyMs,
        retrieval: {
          chunkCount: 0,
          sourceCount: 0,
          retrievalQueryCount: 0,
          contextLength: 0,
        },
        tokens: {
          estimatedInput: 0,
          estimatedOutput: 0,
          estimatedTotal: 0,
        },
        costUsd: {
          estimatedGeminiInput: 0,
          estimatedGeminiOutput: 0,
          estimatedGeminiTotal: 0,
        },
        checks: [`ERROR ${message}`],
        question: test.question,
        answer: "",
        notes: test.notes,
        error: message,
      });
      console.log(`ERROR ${test.id} (${test.category}) - ${latencyMs}ms - ${message}`);
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `chatbot-benchmark-${timestamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));

  const passCount = results.filter((result) => result.passed).length;
  const totalCost = results.reduce((sum, result) => sum + result.costUsd.estimatedGeminiTotal, 0);
  const totalTokens = results.reduce((sum, result) => sum + result.tokens.estimatedTotal, 0);

  console.log("");
  console.log(`Results: ${passCount}/${results.length} passed`);
  console.log(`Estimated Gemini tokens: ${totalTokens}`);
  console.log(`Estimated Gemini cost: $${totalCost.toFixed(6)}`);
  console.log(`Report: ${outputPath}`);

  if (passCount !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
