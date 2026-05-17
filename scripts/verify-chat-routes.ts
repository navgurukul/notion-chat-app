/**
 * Smoke-test query routing + SQL answers for common questions.
 * Run: npm run verify:chat-routes
 */
import "dotenv/config";
import { parseQuery } from "../src/lib/query-router";
import { handleMetadataQuery } from "../src/lib/metadata-search";
import { prefetchPagesFromQuestion } from "../src/lib/notion-context";

const CASES: Array<{
  question: string;
  expectKind: string;
  mustInclude?: string[];
}> = [
  {
    question: "What is the current progress on Oscar?",
    expectKind: "status_of",
    mustInclude: ["Oscar", "In Development"],
  },
  {
    question: "What projects is Tamanna assigned to?",
    expectKind: "assigned_list",
    mustInclude: ["Tamanna"],
  },
  {
    question: "can you tell me about Employee Onboarding Hub",
    expectKind: "page_about",
    mustInclude: ["Onboarding"],
  },
  {
    question: "Structuring the Product Team — What's the Core Idea",
    expectKind: "page_about",
    mustInclude: ["builders", "Structuring"],
  },
  {
    question: "Structuring the Product Team - What's the Core Idea",
    expectKind: "page_about",
    mustInclude: ["builders", "Structuring"],
  },
  {
    question: "What is the ETA for completion of the project journaling app?",
    expectKind: "project_eta",
    mustInclude: ["Journaling"],
  },
  {
    question: "Who is the most active team member in Stub?",
    expectKind: "team_activity",
    mustInclude: ["Stub"],
  },
  {
    question: "What are all the blockers in the projects in Navgurukul workspace?",
    expectKind: "blocker_list",
    mustInclude: ["blocker", "Blocked"],
  },
  {
    question: "Who is assigned to ReportList?",
    expectKind: "assigned_to_of",
    mustInclude: ["Tamanna", "Aniket"],
  },
  {
    question: "Summarize what the Employee Onboarding Hub is for",
    expectKind: "page_about",
    mustInclude: ["Onboarding", "PnC"],
  },
  {
    question: "which project komal is working currently",
    expectKind: "activity_summary",
    mustInclude: ["komal", "Komal"],
  },
  {
    question: "in 2026 which project tamanna is working on?",
    expectKind: "activity_summary",
    mustInclude: ["tamanna", "2026", "no project assigned"],
  },
  {
    question: "what project komal has worked in 2025",
    expectKind: "activity_summary",
    mustInclude: ["komal", "2025", "Reflection"],
  },
  {
    question: "all the projects komal has worked in 2026",
    expectKind: "activity_summary",
    mustInclude: ["komal", "2026", "Reflection"],
  },
  {
    question: "which task tamanna has worked on?",
    expectKind: "worked_on_list",
    mustInclude: ["tamanna", "Tamanna"],
  },
  {
    question: "Which project is Souvik the owner of?",
    expectKind: "owner_list",
    mustInclude: ["Souvik", "Oscar"],
  },
  {
    question: "pages owned by souvik",
    expectKind: "owner_list",
    mustInclude: ["Souvik", "Oscar"],
  },
];

async function main() {
  let failed = 0;

  for (const test of CASES) {
    const parsed = parseQuery(test.question);
    const sql = await handleMetadataQuery(parsed);
    const prefetch = await prefetchPagesFromQuestion(test.question);

    const kindOk = parsed.kind === test.expectKind;
    const answer = sql || "";
    const includesOk =
      !test.mustInclude ||
      test.mustInclude.some((s) => answer.toLowerCase().includes(s.toLowerCase()));

    const ok = kindOk && (sql ? includesOk : prefetch.length > 0);
    if (!ok) failed += 1;

    console.log(ok ? "PASS" : "FAIL", "—", test.question);
    console.log("  kind:", parsed.kind, kindOk ? "ok" : `expected ${test.expectKind}`);
    console.log("  sql:", sql ? `${sql.length} chars` : "none", "prefetch:", prefetch.length);
    if (!includesOk && test.mustInclude) {
      console.log("  missing one of:", test.mustInclude.join(", "));
    }
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
