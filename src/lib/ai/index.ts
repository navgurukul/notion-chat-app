/**
 * AI layer — embeddings (search) and OpenAI (answers).
 */
export {
  getChatStream,
  getJsonCompletion,
  type ChatHistoryItem,
} from "@/lib/ai/openai";
export {
  embedText,
  embedBatch,
  buildEmbeddingText,
  EMBEDDING_DIMENSIONS,
  isEmbeddingsEnabled,
} from "@/lib/ai/embeddings";
