/**
 * Smoke-test query routing + SQL answers for common questions.
 * Run: npm run verify:chat-routes
 */
import "dotenv/config";
import { resolveQueryRulesOnly } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";
import { prefetchPagesFromQuestion } from "../src/lib/rag/build-context";

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
  {
    question: "summarize datapivot ai project",
    expectKind: "project_summary",
    mustInclude: ["DataPivot", "Nagaada"],
  },
  {
    question: "give me an overview of Oscar project",
    expectKind: "project_summary",
    mustInclude: ["Oscar"],
  },
  {
    question: "provide summry of - Team Learning & Session Report – 02 May",
    expectKind: "page_about",
    mustInclude: ["Managing Dependencies", "Sakshi"],
  },
  {
    question: "owner of Team Learning & Session Report – 02 May",
    expectKind: "owner_of",
    mustInclude: ["Sakshi"],
  },
  {
    question:
      "summerrize - Proposal for Samyarth Developer Profit-Sharing & Mentorship Model",
    expectKind: "page_about",
    mustInclude: ["synced", "Samyarth"],
  },
  {
    question: "Which project is Tamanna mostly active in?",
    expectKind: "activity_summary",
    mustInclude: ["Tamanna", "Report"],
  },
  {
    question: "which project komal is working currently",
    expectKind: "activity_summary",
    mustInclude: ["komal", "Reflection"],
  },
  {
    question: "Compare Oscar MVP and Oscar App — what's the difference in scope?",
    expectKind: "compare_pages",
    mustInclude: ["Oscar MVP", "Oscar App"],
  },
  {
    question: "What are the main risks mentioned for the Oscar mobile app?",
    expectKind: "risks_for",
    mustInclude: ["Oscar"],
  },
  {
    question: "What onboarding tasks does a new hire need to complete?",
    expectKind: "onboarding_tasks",
    mustInclude: ["Onboarding"],
  },
  {
    question: "what task assigned to tamanna in year 2025",
    expectKind: "assigned_list",
    mustInclude: ["Tamanna", "2025", "ReportList"],
  },
  {
    question: "what task assigned to tamanna in year 2026",
    expectKind: "assigned_list",
    mustInclude: ["tamanna", "2026"],
  },
  {
    question: "Summarize the main themes across all Zuvy-related docs",
    expectKind: "semantic",
  },
  {
    question: "Why did we choose this architecture for the payments module?",
    expectKind: "semantic",
  },
];

async function main() {
  let failed = 0;

  for (const test of CASES) {
    const parsed = resolveQueryRulesOnly(test.question);
    const sql = await handleMetadataQuery(parsed);
    const prefetch = await prefetchPagesFromQuestion(test.question);

    const kindOk = parsed.kind === test.expectKind;
    const answer = sql || "";
    const includesOk =
      !test.mustInclude ||
      test.mustInclude.some((s) => answer.toLowerCase().includes(s.toLowerCase()));

    const semanticOk = test.expectKind === "semantic" && kindOk && prefetch.length > 0;
    const ok =
      semanticOk || (kindOk && (sql ? includesOk : prefetch.length > 0));
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
