/**
 * @deprecated Content consolidated into ./routing-policy as part of the
 * chat/ directory simplification. This file is kept as a backward-compatible
 * re-export so existing imports of `@/lib/chat/answer-quality` keep working.
 * New code should import directly from `./routing-policy`.
 */
export { isSqlMissAnswer, isTeamActivityMetadataGap, shouldFallbackToRag } from "./routing-policy";