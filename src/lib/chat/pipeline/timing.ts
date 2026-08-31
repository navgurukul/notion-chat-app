/**
 * @deprecated Content consolidated into ./telemetry as part of the chat/
 * directory simplification. This file is kept as a backward-compatible
 * re-export so existing imports of `@/lib/chat/pipeline/timing` keep working.
 * New code should import directly from `./telemetry`.
 */
export type {
  ResolvedEntityTrace,
  PipelineTrace,
  PipelineContext,
  PipelineTimings,
} from "./telemetry";

export { createEmptyTimings, LATENCY_BUDGETS } from "./telemetry";