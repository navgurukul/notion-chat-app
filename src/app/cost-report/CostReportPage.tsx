"use client";

import {
  CHAT_PRICES,
  embeddingMonthlyUsdFromTokens,
  llmMonthlyUsdFromTokens,
  OPENAI_EMBEDDING_PRICING,
  formatMoney,
} from "./AwsComputeCost";

const USD_TO_INR = 94.5;

function formatMoneyInr(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `₹${(n * USD_TO_INR).toFixed(2)}`;
}

function ThinMoneyRow({ usd }: { usd: number }) {
  return (
    <div className="text-xs text-white/60 mt-0.5">
      <span className="mr-2">INR: {formatMoneyInr(usd)}</span>
    </div>
  );
}



import { useEffect, useMemo, useState } from "react";





type Model = {
  id: string;
  label: string;
};

const MODELS: Model[] = [
  { id: "gpt-4o-mini", label: "GPT-4o-mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
];


function fmtNumber(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(2);
}

const ASSUMPTIONS = {
  // Token estimation rules of thumb.
  // token ≈ chars / 4 (the repo uses the same estimator for chunking).
  avgPromptTokensPerQuestion: 450,
  avgRetrievalContextTokensPerQuestion: 900,
  avgCompletionTokensPerQuestion: 650,

  // Multiplier assumptions for retries/regenerations.
  avgRetryMultiplier: 1.0,
};



function estimateMonthlyForModel({
  model,
  users,
  questionsPerUserPerDay,
}: {
  model: Model;
  users: number;
  questionsPerUserPerDay: number;
}) {
  const retryMult = ASSUMPTIONS.avgRetryMultiplier;
  const questionsPerDay = users * questionsPerUserPerDay;

  const promptTokens = questionsPerDay * ASSUMPTIONS.avgPromptTokensPerQuestion * retryMult;
  const retrievalTokens =
    questionsPerDay * ASSUMPTIONS.avgRetrievalContextTokensPerQuestion * retryMult;
  const completionTokens =
    questionsPerDay * ASSUMPTIONS.avgCompletionTokensPerQuestion * retryMult;

  const inputTokens = promptTokens + retrievalTokens;
  const outputTokens = completionTokens;

  // Keep return shape but remove any dollar-based pricing.
  const tokensDaily = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };

  const tokensMonthly = {
    inputTokens: inputTokens * 30,
    outputTokens: outputTokens * 30,
    totalTokens: (inputTokens + outputTokens) * 30,
  };

  const tokensYearly = {
    inputTokens: inputTokens * 365,
    outputTokens: outputTokens * 365,
    totalTokens: (inputTokens + outputTokens) * 365,
  };

  return {
    model,
    questionsPerDay,
    tokensDaily,
    tokensMonthly,
    tokensYearly,
  };
}


export default function CostReportPage() {
  const [users, setUsers] = useState(2);
  const [questionsPerUserPerDay, setQuestionsPerUserPerDay] = useState(10);

  const [llmUsage, setLlmUsage] = useState<
    | null
    | {
        modelId: string;
        totals: {
          inputTokensEst: number;
          outputTokensEst: number;
          totalTokensEst: number;
          inputUsdEst: number;
          outputUsdEst: number;
          totalUsdEst: number;
          totalUserMessages: number;
          totalBotMessages: number;
        };
        users: {
          userId: string;
          email: string;
          name: string | null;
          totalUserMessages: number;
          totalBotMessages: number;
          inputTokensEst: number;
          outputTokensEst: number;
          totalTokensEst: number;
          inputUsdEst: number;
          outputUsdEst: number;
          totalUsdEst: number;
        }[];
      }
  >(null);
  const [llmUsageLoading, setLlmUsageLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLlmUsageLoading(true);
        const res = await fetch("/api/cosr-report/llm-usage", {
          method: "GET",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          modelId: string;
          totals: {
            inputTokensEst: number;
            outputTokensEst: number;
            totalTokensEst: number;
            inputUsdEst: number;
            outputUsdEst: number;
            totalUsdEst: number;
            totalUserMessages: number;
            totalBotMessages: number;
          };
          users: {
            userId: string;
            email: string;
            name: string | null;
            totalUserMessages: number;
            totalBotMessages: number;
            inputTokensEst: number;
            outputTokensEst: number;
            totalTokensEst: number;
            inputUsdEst: number;
            outputUsdEst: number;
            totalUsdEst: number;
          }[];
        };
        if (cancelled) return;
        setLlmUsage(data);
      } catch (e) {
        console.error("Failed to load LLM usage", e);
        if (cancelled) return;
        setLlmUsage(null);
      } finally {
        if (!cancelled) setLlmUsageLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([
    "gpt-4o-mini",
    "deepseek-chat",
  ]);



  const selectedModels = useMemo(
    () => MODELS.filter((m) => selectedModelIds.includes(m.id)),
    [selectedModelIds]
  );

  const modelEstimates = useMemo(() => {
    return selectedModels.map((model) =>
      estimateMonthlyForModel({
        model,
        users,
        questionsPerUserPerDay,
      })
    );
  }, [selectedModels, users, questionsPerUserPerDay]);




  type CostMode = "llm" | "embedding";
  const [costMode, setCostMode] = useState<CostMode>("llm");



  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-6xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-3xl font-extrabold">Cost Report (Estimate)</h1>
          <p className="text-white/60 mt-2 text-sm leading-relaxed">
            Interactive estimation for model + infra monthly cost. Token estimation uses the repo heuristic
            (token ≈ chars / 4) and average tokens per question.
          </p>
        </div>

        {/* Controls */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6">
          <h2 className="font-bold text-lg">Inputs</h2>

          <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs text-white/70">LLM usage model</div>
              <div className="text-sm text-white/85 mt-1">Estimate from stored chat messages: tokens ≈ chars/4</div>
            </div>
          </div>


          <div className="mt-4 mb-4 flex flex-col gap-2">
            <div className="text-sm text-white/70">Cost mode</div>
            <div className="flex flex-wrap gap-4">

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="costMode"
                  checked={costMode === "llm"}
                  onChange={() => setCostMode("llm")}
                />
                <span>LLM i/p-o/p cost</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="costMode"
                  checked={costMode === "embedding"}
                  onChange={() => setCostMode("embedding")}
                />
                <span>Embedding cost</span>
              </label>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">

            <label className="rounded-xl bg-black/20 border border-white/10 p-4">
              <div className="text-xs text-white/55">Users (scroll to adjust)</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-2xl font-bold">{users}</div>
                <input
                  aria-label="users"
                  className="w-full"
                  type="range"
                  min={1}
                  max={200}
                  step={1}
                  value={users}
                  onChange={(e) => setUsers(Number(e.target.value))}
                />
              </div>
            </label>

            <label className="rounded-xl bg-black/20 border border-white/10 p-4">
              <div className="text-xs text-white/55">Questions per user / day</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-2xl font-bold">{questionsPerUserPerDay}</div>
                <input
                  aria-label="questionsPerUserPerDay"
                  className="w-full"
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={questionsPerUserPerDay}
                  onChange={(e) => setQuestionsPerUserPerDay(Number(e.target.value))}
                />
              </div>
            </label>

            <div className="rounded-xl bg-black/20 border border-white/10 p-4">
              <div className="text-xs text-white/55">Models (select multiple)</div>
              <div className="mt-2 flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
                {MODELS.map((m) => {
                  const checked = selectedModelIds.includes(m.id);
                  return (
                    <label key={m.id} className="flex items-center justify-between gap-3">
                      <span className="text-sm text-white/85">{m.id}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedModelIds((prev) => {
                            if (e.target.checked) return Array.from(new Set([...prev, m.id]));
                            return prev.filter((id) => id !== m.id);
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </div>

            </div>
          </div>

          {/* Overall */}
        <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs text-white/70">Overall monthly API cost (estimate)</div>
          <div className="text-3xl font-extrabold mt-1">
{(() => {
                  const usd =
                    selectedModels.length === 0
                      ? 0
                      : costMode === "llm"
                        ? selectedModels.reduce((sum, m) => {
                            const pricing = CHAT_PRICES[m.id];
                            if (!pricing) return sum;
                            const idx = selectedModels.findIndex(
                              (x) => x.id === m.id
                            );
                            const est = modelEstimates[idx];
                            if (!est) return sum;

                            if (
                              !Number.isFinite(
                                pricing.inputPer1MTokensUsd
                              ) ||
                              !Number.isFinite(pricing.outputPer1MTokensUsd)
                            ) {
                              return sum;
                            }

                            return (
                              sum +
                              llmMonthlyUsdFromTokens({
                                inputTokens:
                                  est.tokensMonthly.inputTokens,
                                outputTokens:
                                  est.tokensMonthly.outputTokens,
                                pricing,
                              })
                            );
                          }, 0)
                        : embeddingMonthlyUsdFromTokens({
                            // NOTE: embeddings are expensive for indexing; this report currently models query embeddings + a stored approximation.
                            inputTokens:
                              users *
                              questionsPerUserPerDay *
                              ASSUMPTIONS.avgRetrievalContextTokensPerQuestion *
                              30,
                            pricing: OPENAI_EMBEDDING_PRICING,
                          });

                  return (
                    <>
                      <span className="inline-block">{formatMoney(usd)}</span>
                      <ThinMoneyRow usd={usd} />
                    </>
                  );
                })()}

              </div>

            </div>
            <div className="text-sm text-white/70">
              <div>
                {costMode === "llm" ? "Sum of selected LLM i/p-o/p costs" : "Embedding cost (query+stored approximation)"}
              </div>
            </div>
          </div>
        </div>


        </div>

        {/* Actual usage */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6">
          <h2 className="font-bold text-lg">LLM Usage (Actual, till now)</h2>

          {llmUsageLoading ? (
            <div className="mt-3 text-sm text-white/60">Loading usage...</div>
          ) : llmUsage ? (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <div className="text-xs text-white/50">Total questions</div>
                <div className="text-2xl font-bold mt-1">{llmUsage.totals.totalUserMessages}</div>
                <div className="text-xs text-white/60 mt-1">Total answers: {llmUsage.totals.totalBotMessages}</div>
              </div>

              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <div className="text-xs text-white/50">Estimated tokens</div>
                <div className="text-2xl font-bold mt-1">{fmtNumber(llmUsage.totals.totalTokensEst)}</div>
                <div className="text-xs text-white/60 mt-1">Input {fmtNumber(llmUsage.totals.inputTokensEst)} • Output {fmtNumber(llmUsage.totals.outputTokensEst)}</div>
              </div>


              <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                <div className="text-xs text-white/50">Estimated cost so far</div>
                <div className="text-2xl font-bold mt-1">
                  {formatMoney(llmUsage.totals.totalUsdEst)}
                </div>
                <ThinMoneyRow usd={llmUsage.totals.totalUsdEst} />
                <div className="text-xs text-white/60 mt-1">Model priced: {llmUsage.modelId}</div>

              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-white/60">No usage data found (or not authorized).</div>
          )}

          {llmUsage && llmUsage.users.length > 0 ? (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h3 className="font-semibold">Per-user breakdown</h3>
                <div className="text-xs text-white/50">Showing top {llmUsage.users.length}</div>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {llmUsage.users.map((u) => (
                  <div key={u.userId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold truncate">{u.name || u.email}</div>
                        <div className="text-xs text-white/60">Questions: {u.totalUserMessages}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-white/60">Cost</div>
                        <div className="text-lg font-extrabold">{formatMoney(u.totalUsdEst)}</div>
                        <ThinMoneyRow usd={u.totalUsdEst} />

                      </div>
                    </div>
                    <div className="mt-3 text-xs text-white/60">
                      Input {fmtNumber(u.inputTokensEst)} • Output {fmtNumber(u.outputTokensEst)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>


        {/* Assumptions */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 mb-6">
          <h2 className="font-bold text-lg">Assumptions</h2>
          <ul className="mt-3 text-sm text-white/70 space-y-1 list-disc pl-5">
            <li>Avg prompt tokens/question: {ASSUMPTIONS.avgPromptTokensPerQuestion}</li>
            <li>Avg retrieved context tokens/question: {ASSUMPTIONS.avgRetrievalContextTokensPerQuestion}</li>
            <li>Avg completion tokens/question: {ASSUMPTIONS.avgCompletionTokensPerQuestion}</li>
            <li>Average retry/regenerate multiplier: {ASSUMPTIONS.avgRetryMultiplier}×</li>
          </ul>
          <div className="mt-3 text-xs text-white/45">
            Deployment infra assumed: <b>t3.small EC2 + RDS</b> (monthly placeholders).
          </div>
        </div>

        {/* Breakdown */}
        <div>
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg">Per-model breakdown</h2>
            <div className="text-xs text-white/50">
              Usage: ~{users} users × {questionsPerUserPerDay} questions/day/user
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            {selectedModels.map((model, idx) => {
              const est = modelEstimates[idx];
              return (
                <div key={model.id} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-bold">{model.label}</h3>
                      <p className="text-sm text-white/60">~{est.questionsPerDay} questions/day total</p>
                    </div>

                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Monthly tokens</div>
                      <div className="text-2xl font-bold mt-1">{fmtNumber(est.tokensMonthly.totalTokens)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {fmtNumber(est.tokensMonthly.inputTokens)} • Output {fmtNumber(est.tokensMonthly.outputTokens)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Daily tokens</div>
                      <div className="text-2xl font-bold mt-1">{fmtNumber(est.tokensDaily.totalTokens)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {fmtNumber(est.tokensDaily.inputTokens)} • Output {fmtNumber(est.tokensDaily.outputTokens)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Yearly tokens</div>
                      <div className="text-2xl font-bold mt-1">{fmtNumber(est.tokensYearly.totalTokens)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {fmtNumber(est.tokensYearly.inputTokens)} • Output {fmtNumber(est.tokensYearly.outputTokens)}
                      </div>
                    </div>

                  </div>

                  <div className="mt-4 text-xs text-white/55">
                    Token inputs (daily): prompt+retrieval {fmtNumber(est.tokensDaily.inputTokens)} • completion {" "}
                    {fmtNumber(est.tokensDaily.outputTokens)}
                  </div>

                </div>
              );
            })}
          </div>

          {selectedModels.length === 0 ? (
            <div className="mt-6 text-sm text-white/60">Select at least one model.</div>
          ) : null}
        </div>

        <div className="mt-8 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
          <h2 className="font-bold text-lg text-amber-200">Risks & Cost Spike Prevention</h2>
          <ul className="mt-3 text-sm text-white/75 space-y-2 list-disc pl-5">
            <li>
              <b>Context bloat:</b> retrieved context grows prompt size (input tokens).
              Mitigation: cap context/chunks; lower chunk size/overlap; add top-K limits.
            </li>
            <li>
              <b>Regeneration / retries:</b> user regenerates answers or server retries.
              Mitigation: UI cooldown, stricter stop/abort handling, lower max retries, cache retrieval.
            </li>
            <li>
              <b>Over-long outputs:</b> high completion tokens can dominate cost.
              Mitigation: enforce max_tokens, add concise system instruction, truncate conversation history.
            </li>
            <li>
              <b>Prompt injection / runaway:</b> malicious text can cause larger reasoning.
              Mitigation: keep system prompt strict; validate outputs; hard cap output length.
            </li>
            <li>
              <b>Tier growth surprises:</b> daily questions/day can spike.
              Mitigation: rate limit per user, monitor daily token usage, alert thresholds.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}


