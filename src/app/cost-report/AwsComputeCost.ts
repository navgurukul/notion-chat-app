export function formatMoney(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

// Pricing constants (USD) — provided by the task owner.
// Prices are per 1M tokens.

export type ChatPrice = {
  inputPer1MTokensUsd: number;
  outputPer1MTokensUsd: number;
};

export type EmbeddingPrice = {
  inputPer1MTokensUsd: number;
};

export const CHAT_PRICES: Record<string, ChatPrice> = {
  "gpt-4o-mini": { inputPer1MTokensUsd: 0.15, outputPer1MTokensUsd: 0.6 },
  "gpt-4.1": { inputPer1MTokensUsd: 2.0, outputPer1MTokensUsd: 8.0 },
  "deepseek-chat": { inputPer1MTokensUsd: 0.14, outputPer1MTokensUsd: 0.28 },
  // If you still select this model in UI but don't have pricing, it will show as —.
  "deepseek-4": { inputPer1MTokensUsd: Number.NaN, outputPer1MTokensUsd: Number.NaN },
};

export const OPENAI_EMBEDDING_PRICING: EmbeddingPrice = {
  // text-embedding-3-small: $0.02 / 1M input tokens
  inputPer1MTokensUsd: 0.02,
};

export function llmMonthlyUsdFromTokens({
  inputTokens,
  outputTokens,
  pricing,
}: {
  inputTokens: number;
  outputTokens: number;
  pricing: ChatPrice;
}) {
  const inputUsd =
    (inputTokens / 1_000_000) * pricing.inputPer1MTokensUsd;
  const outputUsd =
    (outputTokens / 1_000_000) * pricing.outputPer1MTokensUsd;

  return inputUsd + outputUsd;
}

export function embeddingMonthlyUsdFromTokens({
  inputTokens,
  pricing,
}: {
  inputTokens: number;
  pricing: EmbeddingPrice;
}) {
  const usd = (inputTokens / 1_000_000) * pricing.inputPer1MTokensUsd;
  return usd;
}




