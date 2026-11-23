import fs from "node:fs";

export interface GoldenItem {
  id: string;
  query: string;
  expected_behavior: "clarify" | "answer";
  expected_page_titles: string[];
  expected_answer_claims: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  history?: { role: "user" | "bot"; content: string }[];
}

export type GoldenEntry = {
  question: string;
  expectedAnswer?: string;
  expected_behavior?: "clarify" | "answer";
  relevantPages?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  history?: { role: "user" | "bot"; content: string }[];
};

/** Reads the contributor-friendly question/answer list in eval/golden-dataset.json. */
export function readGoldenDataset(file: string): GoldenItem[] {
  const entries = JSON.parse(fs.readFileSync(file, "utf8")) as GoldenEntry[];
  return entries.map((entry, index) => {
    const expectedBehavior = entry.expected_behavior ?? "answer";
    if (!entry.question?.trim()) {
      throw new Error(`Golden dataset entry ${index + 1} needs a question.`);
    }
    if (expectedBehavior !== "clarify" && expectedBehavior !== "answer") {
      throw new Error(`Golden dataset entry ${index + 1} has an invalid expected_behavior.`);
    }
    if (expectedBehavior === "answer" && !entry.expectedAnswer?.trim()) {
      throw new Error(`Golden dataset entry ${index + 1} needs an expectedAnswer.`);
    }
    return {
      id: `q${String(index + 1).padStart(3, "0")}`,
      query: entry.question.trim(),
      expected_behavior: expectedBehavior,
      expected_page_titles: entry.relevantPages ?? [],
      expected_answer_claims: entry.expectedAnswer?.trim() ? [entry.expectedAnswer.trim()] : [],
      mustContain: entry.mustContain,
      mustNotContain: entry.mustNotContain,
      history: entry.history,
    };
  });
}
