/**
 * RAG layer — find relevant Notion text for open-ended questions.
 *
 * Flow: question → search chunks/pages → context string for Gemini
 */
export { buildNotionContextForChat, prefetchPagesFromQuestion } from "@/lib/rag/build-context";
export { semanticSearch } from "@/lib/rag/semantic-search";
export { hybridChunkContext, hasNotionChunks } from "@/lib/rag/hybrid-search";
