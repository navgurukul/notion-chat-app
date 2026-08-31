/**
 * @deprecated Content consolidated into ./pipeline/telemetry as part of the
 * chat/ directory simplification. This file is kept as a backward-compatible
 * re-export so existing imports of `@/lib/chat/retrieval-diagnostics` keep
 * working. New code should import directly from `./pipeline/telemetry`.
 */
export type { RouteDecision } from "./pipeline/telemetry";
export { logChatRoute, logRetrievalDiagnostics } from "./pipeline/telemetry";