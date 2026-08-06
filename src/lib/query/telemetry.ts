import type { ParsedQuery } from "./types";

export function logQueryRouting(
  question: string,
  rules: ParsedQuery,
  final: ParsedQuery,
  usedLlm: boolean,
) {
  if (process.env.QUERY_ROUTING_LOG === "false") return;

  const payload = {
    question: question.slice(0, 200),
    rules: { kind: rules.kind, confidence: rules.confidence, source: rules.source },
    final: { kind: final.kind, confidence: final.confidence, source: final.source },
    usedLlm,
    changed: rules.kind !== final.kind || Math.abs(rules.confidence - final.confidence) > 0.05,
  };

  if (process.env.NODE_ENV !== "production" || process.env.QUERY_ROUTING_LOG === "true") {
    console.log("[query-routing]", payload);
  }

  if (final.kind === "semantic" && final.confidence < 0.4) {
    console.log("[query-routing] low_confidence_semantic", { question: question.slice(0, 120) });
  }
}
