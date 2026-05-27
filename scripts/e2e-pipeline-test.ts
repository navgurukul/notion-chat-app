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

  if (parsed.kind !== "semantic") {
    fail("RAG path — routing", `expected semantic, got ${parsed.kind} doc=${parsed.docTitle ?? ""}`);
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
