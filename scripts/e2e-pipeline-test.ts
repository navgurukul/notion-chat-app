/**
 * End-to-end smoke tests: 3 chat paths + chunking/RAG index.
 *
 * Run: npm run test:e2e
 *
 * Requires: .env with DATABASE_URL (and GEMINI_API_KEY for optional LLM check)
 */
import "dotenv/config";
import { query } from "../src/lib/db";
import { chunkPageContent } from "../src/lib/ingestion/chunk";
import { hasNotionChunks, hybridChunkContext } from "../src/lib/rag/hybrid-search";
import { buildNotionContextForChat, prefetchPagesFromQuestion } from "../src/lib/rag/build-context";
import { semanticSearch } from "../src/lib/rag/semantic-search";
import { resolveQuery } from "../src/lib/query/resolve-query";
import { lookupPageLinkByTitle, handleMetadataQuery } from "../src/lib/sql/answers";
import {
  isNotionLinkRequest,
  resolveSemanticSearchQuery,
} from "../src/lib/chat/link-lookup";
import { reformulateSearchQuery } from "../src/lib/chat/query-reformulation";
import { runChatPipeline } from "../src/lib/chat/pipeline";


type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

function pass(name: string, detail: string) {
  results.push({ name, ok: true, detail });
  console.log(`PASS — ${name}`);
  console.log(`       ${detail}\n`);
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`FAIL — ${name}`);
  console.log(`       ${detail}\n`);
}

async function testLinkPath() {
  const question = "Give me the Notion link for ReportList";
  const title = "ReportList";

  if (!isNotionLinkRequest(question)) {
    fail("Link path — detect link intent", "isNotionLinkRequest returned false");
    return;
  }

  const answer = await lookupPageLinkByTitle(title);
  if (!answer || !/notion\.so|Open in Notion/i.test(answer)) {
    fail("Link path — lookup URL", answer?.slice(0, 120) ?? "no answer");
    return;
  }

  pass("Link path (SQL, no LLM)", `kind=link · ${answer.split("\n")[0]?.slice(0, 80)}`);
}

async function testSqlPath() {
  const question = "What is the status of Oscar MVP?";
  const parsed = await resolveQuery(question);

  if (parsed.kind !== "status_of") {
    fail("SQL path — routing", `expected status_of, got ${parsed.kind}`);
    return;
  }

  const answer = await handleMetadataQuery(parsed);
  if (!answer || !/Oscar/i.test(answer)) {
    fail("SQL path — answer", answer?.slice(0, 150) ?? "empty");
    return;
  }

  pass("SQL path (direct Postgres)", `kind=${parsed.kind} · ${answer.replace(/\s+/g, " ").slice(0, 100)}...`);
}

async function testRagPath() {
  const question = "Summarize the main themes across all Zuvy-related docs";
  const parsed = await resolveQuery(question);

  if (parsed.kind !== "semantic" && parsed.kind !== "project_summary") {
    fail("RAG path — routing", `expected semantic or project_summary, got ${parsed.kind} doc=${parsed.docTitle ?? ""}`);
    return;
  }

  const searchQuery = parsed.docTitle?.trim()
    ? `${parsed.docTitle.trim()} ${resolveSemanticSearchQuery(question, [])}`
    : resolveSemanticSearchQuery(question, []);

  const prefetch = await prefetchPagesFromQuestion(searchQuery);
  const context = await buildNotionContextForChat(searchQuery);

  if (!prefetch.trim() && !context.trim()) {
    fail("RAG path — context", "no prefetch and no semantic context");
    return;
  }

  const hasZuvy = /zuvy/i.test(context);
  if (!hasZuvy) {
    fail("RAG path — Zuvy in context", `context_chars=${context.length} but no Zuvy mention`);
    return;
  }

  pass(
    "RAG path (prefetch + search → ready for OpenAI)",
    `kind=semantic · prefetch=${prefetch.length} chars · full_context=${context.length} chars · Zuvy=yes`,
  );

  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      const { getChatStream } = await import("../src/lib/ai/gemini");
      const stream = await getChatStream(question, context.slice(0, 12000), []);
      let text = "";
      for await (const chunk of stream) {
        text += chunk.text();
        if (text.length > 200) break;
      }
      if (text.trim().length > 50) {
        pass("RAG path — OpenAI stream (sample)", `first_chars=${text.trim().slice(0, 80)}...`);
      } else {
        fail("RAG path — OpenAI stream", "stream returned too little text");
      }
    } catch (error) {
      fail("RAG path — OpenAI stream", error instanceof Error ? error.message : String(error));
    }
  } else {
    pass("RAG path — OpenAI stream", "skipped (no OPENAI_API_KEY)");
  }
}

async function testChunkingUnit() {
  const longBody = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkPageContent({
    id: "test-page-id",
    title: "E2E Chunk Test Page",
    content: longBody,
    owner: "Tester",
    status: "In progress",
  });

  if (chunks.length < 3) {
    fail("Chunking — unit split", `expected 3+ chunks, got ${chunks.length}`);
    return;
  }

  const overlapOk = chunks[1].content.includes("word350") || chunks[1].content.includes("word400");
  if (!overlapOk) {
    fail("Chunking — overlap", "second chunk missing overlap region");
    return;
  }

  if (!chunks[0].content.includes("E2E Chunk Test Page")) {
    fail("Chunking — title prefix", "first chunk missing page title prefix");
    return;
  }

  pass("Chunking — unit (400 words, 50 overlap)", `${chunks.length} chunks from 1200 words`);
}

async function testChunkingDatabase() {
  const [pageStats] = await query<{
    pages: string;
    chunks: string;
    embedded_chunks: string;
    embedded_pages: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM notion_pages) AS pages,
      (SELECT count(*)::text FROM notion_chunks) AS chunks,
      (SELECT count(*)::text FROM notion_chunks WHERE embedding IS NOT NULL) AS embedded_chunks,
      (SELECT count(*)::text FROM notion_pages WHERE embedding IS NOT NULL) AS embedded_pages
  `);

  const pages = Number(pageStats?.pages ?? 0);
  const chunks = Number(pageStats?.chunks ?? 0);
  const embeddedChunks = Number(pageStats?.embedded_chunks ?? 0);

  if (pages === 0) {
    fail("Chunking — DB pages", "notion_pages is empty — run Sync changes first");
    return;
  }

  if (chunks === 0) {
    fail("Chunking — DB chunks", "notion_chunks is empty — run sync with embed=true");
    return;
  }

  const hasChunks = await hasNotionChunks();
  if (!hasChunks) {
    fail("Chunking — hasNotionChunks()", "returned false");
    return;
  }

  pass(
    "Chunking — DB index",
    `pages=${pages} · chunks=${chunks} · embedded_chunks=${embeddedChunks} · embedded_pages=${pageStats?.embedded_pages}`,
  );

  const hybrid = await hybridChunkContext("Zuvy Eval adaptive assessment");
  if (!hybrid?.trim()) {
    fail("Chunking — hybrid retrieval", "hybridChunkContext returned empty for Zuvy query");
    return;
  }

  pass("Chunking — hybrid search", `retrieved ${hybrid.length} chars for "Zuvy Eval adaptive assessment"`);

  const semantic = await semanticSearch("Zuvy architecture LMS");
  if (!semantic.trim()) {
    fail("Chunking — semanticSearch()", "empty context");
    return;
  }

  pass("Chunking — semanticSearch pipeline", `${semantic.length} chars context`);
}

async function testYearAssignedRegression() {
  const question = "what task assigned to tamanna in year 2025";
  const parsed = await resolveQuery(question);
  const answer = await handleMetadataQuery(parsed);

  if (parsed.personName?.includes("year")) {
    fail("Regression — year in personName", `personName="${parsed.personName}"`);
    return;
  }

  if (!answer || !/tamanna/i.test(answer) || !/report/i.test(answer)) {
    fail("Regression — Tamanna 2025 tasks", answer?.slice(0, 120) ?? "empty");
    return;
  }

  pass("Regression — assigned + year filter", `person=${parsed.personName} year=${parsed.year} · tasks found`);
}

async function testQueryRoutingRegressions() {
  console.log("--- Query Routing & Multi-Turn Regressions ---\n");

  const singleTurnCases = [
    { q: "assigned to Mahendra", expectKind: "assigned_list" },
    { q: "who is Mahendra", forbidKind: "assigned_list" },
    { q: "list tasks assigned to me", expectKind: "assigned_list" },
    { q: "show assigned issues", expectKind: "assigned_list" },
    { q: "tell me about Rahul", forbidKind: "assigned_list" },
    { q: "leave policy details", forbidKind: "assigned_list", expectKind: "page_about" },
    { q: "who is Mahendra", forbidKind: "assigned_list" },
    { q: "Who are all developers?", expectKind: "people_list" },
    { q: "Which project has the most developers?", expectKind: "project_most_devs" },
    { q: "how many total developers are working in navgurukul?", expectKind: "people_list" },
    { q: "who is working on Oscar MVP?", expectKind: "assigned_to_of" },
    { q: "what projects is Mahendra working on?", expectKind: "assigned_list" },
    { q: "who is the creator of Oscar MVP?", expectKind: "created_by_of" },
    { q: "what task komal is currently working on?", expectKind: "assigned_list" },
    { q: "komal currently working on which task", expectKind: "assigned_list" },
    { q: "komal has worked on which task so far?", expectKind: "assigned_list" },
  ];

  for (const tc of singleTurnCases) {
    const parsed = await resolveQuery(tc.q);
    if (tc.expectKind && parsed.kind !== tc.expectKind) {
      fail(`Single-turn regression: ${tc.q}`, `expected kind ${tc.expectKind}, got ${parsed.kind}`);
      return;
    }
    if (tc.forbidKind && parsed.kind === tc.forbidKind) {
      fail(`Single-turn regression: ${tc.q}`, `forbidden kind ${tc.forbidKind} matched`);
      return;
    }
    pass(`Single-turn regression: ${tc.q}`, `resolved to kind=${parsed.kind}`);
  }

  // Multi-turn Case 1: General person topic to Rahul
  const history1 = [
    { role: "user" as const, content: "Tell me about Mahendra" },
    { role: "bot" as const, content: "Mahendra is a software engineer working on the team." }
  ];
  const ref1 = await reformulateSearchQuery("What about Rahul?", history1);
  const parsed1 = await resolveQuery(ref1.searchQuery);
  if (parsed1.kind === "assigned_list") {
    fail("Multi-turn regression: Rahul query", `incorrectly routed to assigned_list from history leak. Reformulated: "${ref1.searchQuery}"`);
    return;
  }
  pass("Multi-turn regression: Rahul query", `reformulated="${ref1.searchQuery}" kind=${parsed1.kind}`);

  // Multi-turn Case 2: Assigned tasks context followed by Mahendra
  const history2 = [
    { role: "user" as const, content: "Show my assigned tasks" },
    { role: "bot" as const, content: "You have 3 active tasks." }
  ];
  const ref2 = await reformulateSearchQuery("What about Mahendra?", history2);
  const parsed2 = await resolveQuery(ref2.searchQuery);
  if (parsed2.kind !== "assigned_list") {
    fail("Multi-turn regression: Mahendra query", `expected assigned_list, got ${parsed2.kind}. Reformulated: "${ref2.searchQuery}"`);
    return;
  }
  pass("Multi-turn regression: Mahendra query", `reformulated="${ref2.searchQuery}" kind=${parsed2.kind}`);

  // Multi-turn Case 3: Task details request ("tell me more about this task")
  const history3 = [
    { role: "user" as const, content: "what task assined to mahendra in 2026?" },
    { role: "bot" as const, content: "1 result(s) — Bharat FPO Finder — Maintaining · assignee: Amruta, Mahendra Mahendra · edited: 2026-05-06" }
  ];
  const ref3 = await reformulateSearchQuery("tell me more about this task?", history3);
  const parsed3 = await resolveQuery(ref3.searchQuery);
  if (parsed3.kind === "assigned_list") {
    fail("Multi-turn regression: Task details", `incorrectly routed to assigned_list. Reformulated: "${ref3.searchQuery}"`);
    return;
  }
  if (parsed3.docTitle !== "Bharat FPO Finder") {
    fail("Multi-turn regression: Task details title", `expected docTitle "Bharat FPO Finder", got "${parsed3.docTitle}". Reformulated: "${ref3.searchQuery}"`);
    return;
  }
  pass("Multi-turn regression: Task details", `reformulated="${ref3.searchQuery}" kind=${parsed3.kind} docTitle=${parsed3.docTitle}`);

  // Multi-turn Case 4: Pronoun resolution he -> Mahendra
  const history4 = [
    { role: "user" as const, content: "What about Mahendra?" },
    { role: "bot" as const, content: "Mahendra is a developer." }
  ];
  const parsed4 = await resolveQuery("I want all the tasks he got assigned in 2026", history4, undefined, { lastPerson: "Mahendra" });
  if (parsed4.personName !== "Mahendra") {
    fail("Multi-turn pronoun resolution", `expected personName "Mahendra", got "${parsed4.personName}"`);
    return;
  }
  pass("Multi-turn pronoun resolution", `correctly resolved 'he' to '${parsed4.personName}'`);
}

async function testFastPathGreetingsLatency() {
  const mockSession = {
    user: {
      name: "Tester",
      email: "tester@navgurukul.org",
    },
    expires: new Date(Date.now() + 3600000).toISOString(),
  } as any;

  const testCases = [
    { message: "hi" },
    { message: "hello" },
    { message: "thanks" },
    { message: "bye" },
  ];

  for (const tc of testCases) {
    const t0 = performance.now();
    const response = await runChatPipeline(mockSession, { message: tc.message });
    const duration = performance.now() - t0;

    const data = await response.json();

    if (duration > 100) {
      fail(
        `Latency budget exceeded for greeting: "${tc.message}"`,
        `Expected < 100ms, took ${duration.toFixed(2)}ms`,
      );
      return;
    }

    if (!data.answer || !/hello|welcome|goodbye/i.test(data.answer)) {
      fail(
        `Greeting response invalid: "${tc.message}"`,
        `Got: "${data.answer}"`,
      );
      return;
    }

    pass(
      `Fast path latency assertion: "${tc.message}"`,
      `took ${duration.toFixed(2)}ms (budget < 100ms)`,
    );
  }
}

async function main() {
  console.log("=== E2E: 3 chat paths + chunking ===\n");

  console.log("--- Path 1: Link lookup ---\n");
  await testLinkPath();

  console.log("--- Path 2: SQL direct ---\n");
  await testSqlPath();

  console.log("--- Path 3: RAG (+ optional Gemini) ---\n");
  await testRagPath();

  console.log("--- Chunking: unit + database ---\n");
  await testChunkingUnit();
  await testChunkingDatabase();

  console.log("--- Regression ---\n");
  await testYearAssignedRegression();
  await testQueryRoutingRegressions();
  await testFastPathGreetingsLatency();

  const failed = results.filter((r) => !r.ok);
  console.log("=== Summary ===");
  console.log(`Total: ${results.length} · Passed: ${results.length - failed.length} · Failed: ${failed.length}`);

  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }

  console.log("\nAll E2E checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
