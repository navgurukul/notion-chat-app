import "dotenv/config";
import "../src/lib/dns-hook";
process.env.IS_EVALUATION = "true";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { handleMetadataQuery } from "../src/lib/sql/answers";
import { buildNotionContextWithConfidence } from "../src/lib/rag/build-context";
import { isNotionLinkRequest } from "../src/lib/chat/link-lookup";
import { lazyResolveSqlEntities, lazyResolveRagEntities } from "../src/lib/query/entity-resolver";

type TestResult = {
  query: string;
  expected_lane: string;
  actual_lane: string;
  expected_intent: string;
  actual_intent: string;
  expected_entities: any;
  actual_entities: any;
  retrieved_docs: string[];
  recall_ok: boolean;
  intent_ok: boolean;
  entity_ok: boolean;
  lane_ok: boolean;
  failure_reason: string;
  timings: {
    intent_ms: number;
    entity_ms: number;
    sql_ms: number;
    search_ms: number;
    total_ms: number;
  };
};

const CASES: Array<{
  query: string;
  history?: Array<{ role: "user" | "bot"; content: string }>;
  lastEntities?: { lastPerson?: string; lastProject?: string };
  expected_lane: "sql" | "rag" | "chat" | "link";
  expected_intent: string;
  expected_entities?: { person?: string; page?: string; year?: number };
  expected_documents?: string[];
  is_ambiguous?: boolean;
}> = [
  // 1. SQL Queries
  {
    query: "What is Tamanna working on?",
    expected_lane: "sql",
    expected_intent: "activity_summary",
    expected_entities: { person: "Tamanna" },
    expected_documents: ["ReportList"]
  },
  {
    query: "what task komal is currently working on?",
    expected_lane: "sql",
    expected_intent: "assigned_list",
    expected_entities: { person: "Komal" },
    expected_documents: ["Reflection Platform"]
  },
  {
    query: "list tasks assigned to me",
    expected_lane: "sql",
    expected_intent: "assigned_list",
    expected_entities: { person: "Test User" }
  },
  {
    query: "what projects is Mahendra working on?",
    expected_lane: "sql",
    expected_intent: "assigned_list",
    expected_entities: { person: "Mahendra" },
    expected_documents: ["Bharat FPO Finder"]
  },
  {
    query: "which task tamanna has worked on?",
    expected_lane: "sql",
    expected_intent: "worked_on_list",
    expected_entities: { person: "Tamanna" }
  },
  {
    query: "what task mahendra worked on in 2025?",
    expected_lane: "sql",
    expected_intent: "worked_on_list",
    expected_entities: { person: "Mahendra", year: 2025 }
  },
  {
    query: "Which project does Souvik own?",
    expected_lane: "sql",
    expected_intent: "owner_list",
    expected_entities: { person: "Souvik" }
  },
  {
    query: "who own - Career Exploration Pilot",
    expected_lane: "sql",
    expected_intent: "owner_of",
    expected_entities: { page: "Career Exploration Pilot" }
  },
  {
    query: "who is the creator of Oscar MVP?",
    expected_lane: "sql",
    expected_intent: "created_by_of",
    expected_entities: { page: "Oscar MVP" }
  },
  {
    query: "What is the current progress on Oscar?",
    expected_lane: "sql",
    expected_intent: "status_of",
    expected_entities: { page: "Oscar" }
  },
  {
    query: "What is the ETA for completion of the project journaling app?",
    expected_lane: "sql",
    expected_intent: "project_eta",
    expected_entities: { page: "project journaling app" }
  },
  {
    query: "Who are all developers?",
    expected_lane: "sql",
    expected_intent: "people_list"
  },
  {
    query: "how many total developers are working in navgurukul?",
    expected_lane: "sql",
    expected_intent: "people_list"
  },
  {
    query: "Which project has the most developers?",
    expected_lane: "sql",
    expected_intent: "project_most_devs"
  },

  // 2. RAG Queries
  {
    query: "can you tell me about Employee Onboarding Hub",
    expected_lane: "rag",
    expected_intent: "page_about",
    expected_entities: { page: "Employee Onboarding Hub" },
    expected_documents: ["Employee Onboarding Hub"]
  },
  {
    query: "Structuring the Product Team — What's the Core Idea",
    expected_lane: "rag",
    expected_intent: "page_about",
    expected_entities: { page: "Structuring the Product Team" },
    expected_documents: ["Structuring the Product Team"]
  },
  {
    query: "summarize datapivot ai project",
    expected_lane: "rag",
    expected_intent: "project_summary",
    expected_entities: { page: "datapivot ai" },
    expected_documents: ["DataPivot AI"]
  },
  {
    query: "give me an overview of Oscar project",
    expected_lane: "rag",
    expected_intent: "project_summary",
    expected_entities: { page: "Oscar" },
    expected_documents: ["Oscar"]
  },
  {
    query: "What are the main risks mentioned for the Oscar mobile app?",
    expected_lane: "rag",
    expected_intent: "risks_for",
    expected_entities: { page: "Oscar" },
    expected_documents: ["Oscar"]
  },
  {
    query: "What onboarding tasks does a new hire need to complete?",
    expected_lane: "rag",
    expected_intent: "onboarding_tasks",
    expected_documents: ["Employee Onboarding Hub"]
  },
  {
    query: "Summarize the main themes across all Zuvy-related docs",
    expected_lane: "rag",
    expected_intent: "semantic",
    expected_documents: ["Zuvy"]
  },
  {
    query: "Why did we choose this architecture for the payments module?",
    expected_lane: "rag",
    expected_intent: "semantic",
    expected_documents: ["Payments"]
  },

  // 3. Link Queries
  {
    query: "Give me the Notion link for ReportList",
    expected_lane: "link",
    expected_intent: "link",
    expected_entities: { page: "ReportList" }
  },
  {
    query: "link for Structuring the Product Team",
    expected_lane: "link",
    expected_intent: "link",
    expected_entities: { page: "Structuring the Product Team" }
  },

  // 4. Chat / Smalltalk
  {
    query: "hi",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "thanks",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "good morning",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "how are you today?",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "who are you?",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "tell me a joke",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "nice job",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "bye",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },
  {
    query: "what is your name?",
    expected_lane: "chat",
    expected_intent: "smalltalk"
  },

  // 5. Multi-turn / Follow-up
  {
    query: "What about Mahendra?",
    history: [
      { role: "user", content: "Show my assigned tasks" },
      { role: "bot", content: "You have 3 active tasks." }
    ],
    lastEntities: { lastPerson: "Mahendra" },
    expected_lane: "sql",
    expected_intent: "assigned_list",
    expected_entities: { person: "Mahendra" }
  },
  {
    query: "I want all the tasks he got assigned in 2026",
    history: [
      { role: "user", content: "What about Mahendra?" },
      { role: "bot", content: "Mahendra is a developer." }
    ],
    lastEntities: { lastPerson: "Mahendra" },
    expected_lane: "sql",
    expected_intent: "assigned_list",
    expected_entities: { person: "Mahendra", year: 2026 }
  },
  {
    query: "tell me more about this task?",
    history: [
      { role: "user", content: "what task assined to mahendra in 2026?" },
      { role: "bot", content: "1 result(s) — Bharat FPO Finder — Maintaining" }
    ],
    lastEntities: { lastProject: "Bharat FPO Finder" },
    expected_lane: "rag",
    expected_intent: "page_about",
    expected_entities: { page: "Bharat FPO Finder" },
    expected_documents: ["Bharat FPO Finder"]
  },

  // 6. Ambiguous / Edge cases (Clarifications or Fallbacks expected)
  {
    query: "Mahendra",
    expected_lane: "chat",
    expected_intent: "smalltalk",
    is_ambiguous: true
  },
  {
    query: "Project",
    expected_lane: "chat",
    expected_intent: "smalltalk",
    is_ambiguous: true
  },
  {
    query: "Show owner",
    expected_lane: "chat",
    expected_intent: "smalltalk",
    is_ambiguous: true
  },
  {
    query: "Who owns it?",
    expected_lane: "chat",
    expected_intent: "smalltalk",
    is_ambiguous: true
  }
];

function getLaneForIntent(intent: string, question: string): "sql" | "rag" | "chat" | "link" {
  if (isNotionLinkRequest(question)) return "link";
  if (intent === "smalltalk") return "chat";
  
  const SQL_INTENTS = [
    "people_list", "project_most_devs", "assigned_list", "worked_on_list",
    "owner_list", "owner_of", "created_by_of", "created_by_list",
    "project_manager_of", "status_of", "project_eta", "analytics",
    "activity_summary", "team_activity"
  ];
  if (SQL_INTENTS.includes(intent)) return "sql";
  return "rag";
}

async function runEvaluation() {
  console.log("=== STARTING PIPELINE EVALUATION BENCHMARK ===");
  const results: TestResult[] = [];

  for (let i = 0; i < CASES.length; i++) {
    const tc = CASES[i];
    const t0 = performance.now();

    // 1. Resolve query (Intent)
    const tIntentStart = performance.now();
    let parsed = await resolveQuery(
      tc.query,
      tc.history || [],
      "Test User",
      tc.lastEntities
    );
    const dIntent = performance.now() - tIntentStart;

    const actualLane = getLaneForIntent(parsed.kind, tc.query);
    
    // 2. Resolve entities timing lazily
    let dEntity = 0;
    if (actualLane === "sql") {
      const tEntStart = performance.now();
      parsed = await lazyResolveSqlEntities(
        parsed,
        tc.history || [],
        "Test User",
        tc.lastEntities
      );
      dEntity = performance.now() - tEntStart;
    } else if (actualLane === "rag") {
      const tEntStart = performance.now();
      parsed = await lazyResolveRagEntities(
        parsed,
        tc.history || [],
        tc.lastEntities
      );
      dEntity = performance.now() - tEntStart;
    }

    // 3. Execution (SQL or RAG Retrieval)
    let dSql = 0;
    let dSearch = 0;
    let retrievedDocs: string[] = [];
    let sqlAnswer: string | null = null;

    if (actualLane === "sql") {
      const tSqlStart = performance.now();
      sqlAnswer = await handleMetadataQuery(parsed);
      dSql = performance.now() - tSqlStart;
    } else if (actualLane === "rag") {
      const tSearchStart = performance.now();
      const searchQuery = parsed.docTitle || tc.query;
      const retrieval = await buildNotionContextWithConfidence(searchQuery);
      dSearch = performance.now() - tSearchStart;
      retrievedDocs = retrieval.chunkHits.map(h => h.title).filter((t): t is string => t !== null);
    }

    const totalMs = performance.now() - t0;

    // Checks
    const intentOk = parsed.kind === tc.expected_intent;
    const laneOk = actualLane === tc.expected_lane;

    let entityOk = true;
    if (tc.expected_entities) {
      if (tc.expected_entities.person) {
        const expected = tc.expected_entities.person.toLowerCase();
        const actual = (parsed.personName || "").toLowerCase();
        if (actual !== expected && !actual.includes(expected) && !expected.includes(actual)) {
          entityOk = false;
        }
      }
      if (tc.expected_entities.page) {
        const expected = tc.expected_entities.page.toLowerCase();
        const actual = (parsed.docTitle || "").toLowerCase();
        if (actual !== expected && !actual.includes(expected) && !expected.includes(actual)) {
          entityOk = false;
        }
      }
      if (tc.expected_entities.year && parsed.year !== tc.expected_entities.year) {
        entityOk = false;
      }
    }

    let recallOk = true;
    if (tc.expected_documents && tc.expected_documents.length > 0) {
      if (actualLane === "sql") {
        recallOk = tc.expected_documents.every(expected => 
          sqlAnswer?.toLowerCase().includes(expected.toLowerCase()) ?? false
        );
      } else {
        recallOk = tc.expected_documents.every(expected => 
          retrievedDocs.some(ret => ret.toLowerCase().includes(expected.toLowerCase()))
        );
      }
    }

    // Failure Diagnostics
    let failureReason = "None";
    if (!laneOk || !intentOk) {
      failureReason = "Intent Wrong";
    } else if (!entityOk) {
      failureReason = "Entity Wrong";
    } else if (!recallOk) {
      failureReason = "Retriever Miss";
    }

    results.push({
      query: tc.query,
      expected_lane: tc.expected_lane,
      actual_lane: actualLane,
      expected_intent: tc.expected_intent,
      actual_intent: parsed.kind,
      expected_entities: tc.expected_entities,
      actual_entities: { person: parsed.personName, page: parsed.docTitle, year: parsed.year },
      retrieved_docs: retrievedDocs,
      recall_ok: recallOk,
      intent_ok: intentOk,
      entity_ok: entityOk,
      lane_ok: laneOk,
      failure_reason: failureReason,
      timings: {
        intent_ms: Math.round(dIntent),
        entity_ms: Math.round(dEntity),
        sql_ms: Math.round(dSql),
        search_ms: Math.round(dSearch),
        total_ms: Math.round(totalMs)
      }
    });

    console.log(`[${i+1}/${CASES.length}] ${tc.query}`);
    console.log(`      Lane: ${laneOk ? "✅" : "❌"} ${actualLane} (expected: ${tc.expected_lane})`);
    console.log(`    Intent: ${intentOk ? "✅" : "❌"} ${parsed.kind} (expected: ${tc.expected_intent})`);
    if (tc.expected_entities) {
      console.log(`  Entities: ${entityOk ? "✅" : "❌"} Got: person=${parsed.personName}, page=${parsed.docTitle}, year=${parsed.year}`);
    }
    if (tc.expected_documents) {
      console.log(`    Recall: ${recallOk ? "✅" : "❌"} (Expected in Top-5: ${tc.expected_documents.join(", ")})`);
    }
    if (failureReason !== "None") {
      console.log(`   Failure: ⚠️ ${failureReason}`);
    }
    console.log(`    Timing: ${Math.round(totalMs)}ms (Intent: ${Math.round(dIntent)}ms, SQL: ${Math.round(dSql)}ms, Search: ${Math.round(dSearch)}ms)`);
    console.log("-".repeat(50));
  }

  // Summarize Results
  const total = results.length;
  const lanePassed = results.filter(r => r.lane_ok).length;
  const intentPassed = results.filter(r => r.intent_ok).length;
  const entityPassed = results.filter(r => r.entity_ok).length;
  const recallPassed = results.filter(r => r.recall_ok).length;
  const allPassedCount = results.filter(r => r.failure_reason === "None").length;

  console.log("\n=== EVALUATION REPORT SUMMARY ===");
  console.log(`Total Cases Evaluated: ${total}`);
  console.log(`Lane Accuracy        : ${lanePassed}/${total} (${((lanePassed/total)*100).toFixed(1)}%)`);
  console.log(`Intent Accuracy      : ${intentPassed}/${total} (${((intentPassed/total)*100).toFixed(1)}%)`);
  console.log(`Entity Accuracy      : ${entityPassed}/${total} (${((entityPassed/total)*100).toFixed(1)}%)`);
  console.log(`Retrieval Recall@5   : ${recallPassed}/${total} (${((recallPassed/total)*100).toFixed(1)}%)`);
  console.log(`Overall Success Rate : ${allPassedCount}/${total} (${((allPassedCount/total)*100).toFixed(1)}%)`);

  console.log("\n=== FAILURE DIAGNOSTIC BREAKDOWN ===");
  const failures = results.filter(r => r.failure_reason !== "None");
  if (failures.length === 0) {
    console.log("No failures! All routing, entities, and retrievals succeeded.");
  } else {
    const reasons: Record<string, number> = {};
    for (const f of failures) {
      reasons[f.failure_reason] = (reasons[f.failure_reason] || 0) + 1;
      console.log(`Query: "${f.query}"`);
      console.log(`  Reason: ${f.failure_reason}`);
      console.log(`  Expected: lane=${f.expected_lane}, intent=${f.expected_intent}`);
      console.log(`  Actual  : lane=${f.actual_lane}, intent=${f.actual_intent}`);
      if (f.actual_lane === "rag" && f.retrieved_docs.length > 0) {
        console.log(`  Retrieved Top Docs: ${f.retrieved_docs.slice(0, 3).join(", ")}`);
      }
      console.log();
    }
    console.log("Summary of failure reasons:", reasons);
  }
}

runEvaluation().catch(console.error);
