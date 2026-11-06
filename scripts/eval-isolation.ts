/**
 * Checks deterministic answer requirements intended to catch cross-page leaks.
 * Usage: npm run eval:isolation
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import path from "node:path";

import { getChatResponse } from "../src/lib/ai/openai";
import { buildNotionContextWithConfidence } from "../src/lib/rag/build-context";
import { readGoldenDataset } from "./golden-dataset";

export async function evaluateIsolation(datasetPath?: string) {
  const file = datasetPath || path.join(process.cwd(), "eval", "golden-dataset.json");
  const entries = readGoldenDataset(file).filter(
    (entry) => entry.mustContain?.length || entry.mustNotContain?.length,
  );
  let failed = 0;

  for (const entry of entries) {
    try {
      const { context } = await buildNotionContextWithConfidence([entry.query]);
      const answer = await getChatResponse(entry.query, context, entry.history ?? []);
      const normalizedAnswer = answer.toLowerCase();
      const missing = (entry.mustContain ?? []).filter((term) => !normalizedAnswer.includes(term.toLowerCase()));
      const leaked = (entry.mustNotContain ?? []).filter((term) => normalizedAnswer.includes(term.toLowerCase()));

      if (missing.length || leaked.length) {
        failed++;
        console.log(`FAIL: ${entry.query}`);
        if (missing.length) console.log("  missing:", missing);
        if (leaked.length) {
          console.log("  leaked:", leaked);
          console.log(
            "  context had leaked terms:",
            leaked.filter((term) => context.toLowerCase().includes(term.toLowerCase())),
          );
        }
      } else {
        console.log(`PASS: ${entry.query}`);
      }
    } catch (err) {
      failed++;
      console.error(`ERROR: ${entry.query}:`, err);
    }
  }

  console.log(`${entries.length - failed}/${entries.length} passed`);
  return { total: entries.length, failed };
}

async function main() {
  const { failed } = await evaluateIsolation();
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Isolation evaluation failed:", err);
    process.exit(1);
  });
}
