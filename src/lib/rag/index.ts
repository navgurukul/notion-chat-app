/**
 * RAG layer — find relevant Notion text for open-ended questions.
 *
 * Flow: question → search chunks/pages → context string for the chat LLM
 */
export { buildNotionContextForChat, prefetchPagesFromQuestion } from "@/lib/rag/build-context";
export { semanticSearch } from "@/lib/rag/semantic-search";
export {
  hybridChunkContext,
  hybridChunkContextFromQueries,
  hasNotionChunks,
} from "@/lib/rag/hybrid-search";
export { expandSearchQueries, isMultiQueryRagEnabled } from "@/lib/chat/multi-query";
export { selectWithMMR, isMmrEnabled } from "@/lib/rag/mmr";
