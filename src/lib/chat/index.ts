/**
 * Chat layer — user message in, answer out.
 *
 * Start here: `pipeline.ts` → `runChatPipeline`
 */
export { handleChatPost } from "@/lib/chat/handler";
export { runChatPipeline, ChatValidationError, ChatNotFoundError } from "@/lib/chat/pipeline";
export type { ChatRequestBody } from "@/lib/chat/pipeline";
export { sanitizeChatHistory, buildContextualSearchQuery } from "@/lib/chat/history";
export {
  reformulateSearchQuery,
  type ReformulatedSearchQuery,
  type QueryReformulationMethod,
} from "@/lib/chat/query-reformulation";
export {
  isNotionLinkRequest,
  extractReferencedTitle,
  resolveSemanticSearchQuery,
} from "@/lib/chat/link-lookup";
export { streamOpenAIAnswer } from "@/lib/chat/stream-response";
export {
  addChatMessage,
  CHAT_HISTORY_LIMIT,
  clearChatMessages,
  createChatSession,
  deleteChatSession,
  ensureSessionBelongsToUser,
  getOrCreateUser,
  listChatMessages,
  listChatSessions,
} from "@/lib/chat/store";
export {
  dedupeRepeatedAnswer,
  extractFinalAnswer,
  stripInternalReasoning,
  stripStreamTags,
  STREAM_TAGS,
} from "@/lib/chat/stream-tags";
