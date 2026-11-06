import fs from "node:fs";

export interface GoldenItem {
  id: string;
  query: string;
  expected_page_titles: string[];
  expected_answer_claims: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  history?: { role: "user" | "bot"; content: string }[];
}

export type GoldenEntry = {
  question: string;
  expectedAnswer: string;
  relevantPages?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  history?: { role: "user" | "bot"; content: string }[];
};

/** Reads the contributor-friendly question/answer list in eval/golden-dataset.json. */
export function readGoldenDataset(file: string): GoldenItem[] {
  const entries = JSON.parse(fs.readFileSync(file, "utf8")) as GoldenEntry[];
  return entries.map((entry, index) => {
    if (!entry.question?.trim() || !entry.expectedAnswer?.trim()) {
      throw new Error(`Golden dataset entry ${index + 1} needs a question and expectedAnswer.`);
    }
    return {
      id: `q${String(index + 1).padStart(3, "0")}`,
      query: entry.question.trim(),
      expected_page_titles: entry.relevantPages ?? [],
      expected_answer_claims: [entry.expectedAnswer.trim()],
      mustContain: entry.mustContain,
      mustNotContain: entry.mustNotContain,
      history: entry.history,
    };
  });
}
