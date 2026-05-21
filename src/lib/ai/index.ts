/**
 * AI layer — embeddings (search) and Gemini (answers).
 */
export {
  getChatStream,
  getJsonCompletion,
  type ChatHistoryItem,
} from "@/lib/ai/gemini";
export { embedText, embedBatch, buildEmbeddingText, EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";
