"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CHAT_PRICES,
  embeddingMonthlyUsdFromTokens,
  llmMonthlyUsdFromTokens,
  OPENAI_EMBEDDING_PRICING,
  formatMoney,
} from "./AwsComputeCost";

const FALLBACK_USD_TO_INR = 94.5; // only used until the live rate loads (or if it fails)

function formatMoneyInr(n: number, rate: number) {
  if (!Number.isFinite(n)) return "—";
  return `₹${(n * rate).toFixed(2)}`;
}

function ThinMoneyRow({ usd, rate }: { usd: number; rate: number }) {
  return (
    <div className="text-xs text-white/60 mt-0.5">
      <span className="mr-2">INR: {formatMoneyInr(usd, rate)}</span>
    </div>
  );
}

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

  // Embeddings only run on the user's raw query text, not on the retrieved
  // context (that context is already-embedded stored data being read back,
  // not re-embedded). This is intentionally much smaller than the LLM
  // prompt size above.
  avgQueryTokensForEmbedding: 60,

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

  const [usdToInr, setUsdToInr] = useState(FALLBACK_USD_TO_INR);
  const [usdToInrSource, setUsdToInrSource] = useState<
    "loading" | "live" | "cache" | "stale-cache" | "fallback"
  >("loading");

  useEffect(() => {
    let cancelled = false;

    async function loadRate() {
      try {
        const res = await fetch("/api/cost-report/exchange-rate");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          usdToInr: number;
          source: "live" | "cache" | "stale-cache" | "fallback";
        };
        if (cancelled) return;
        if (Number.isFinite(data.usdToInr)) {
          setUsdToInr(data.usdToInr);
          setUsdToInrSource(data.source);
        }
      } catch (e) {
        console.error("Failed to load live exchange rate, using fallback", e);
        if (!cancelled) setUsdToInrSource("fallback");
      }
    }

    loadRate();
    return () => {
      cancelled = true;
    };
  }, []);

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
  const [llmUsageError, setLlmUsageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLlmUsageLoading(true);
        setLlmUsageError(null);
        const res = await fetch("/api/cost-report/llm-usage", {
          method: "GET",
        });
        if (res.status === 403) throw new Error("forbidden");
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
        setLlmUsageError(
          e instanceof Error && e.message === "forbidden"
            ? "You're not authorized to view this report."
            : "Couldn't load usage data — please try again.",
        );
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

  // Infra is a real monthly cost of running this, but there's no way to
  // derive it from usage data — user enters it directly instead of the
  // page silently implying it's included when it never was.
  const [infraMonthlyUsd, setInfraMonthlyUsd] = useState(25);

  // One-time (or "whenever content changes") cost of embedding your stored
  // Notion content for indexing — separate from the recurring per-query
  // embedding cost below. Default is a rough placeholder; adjust to your
  // actual corpus size.
  const [indexTokens, setIndexTokens] = useState(500_000);



  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
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

          {costMode === "embedding" ? (
            <label className="rounded-xl bg-black/20 border border-white/10 p-4 mb-4 block">
              <div className="text-xs text-white/55">
                Content to index — one-time, not monthly (tokens)
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <div className="text-2xl font-bold">{fmtNumber(indexTokens)}</div>
                <input
                  aria-label="indexTokens"
                  className="w-full"
                  type="range"
                  min={10_000}
                  max={5_000_000}
                  step={10_000}
                  value={indexTokens}
                  onChange={(e) => setIndexTokens(Number(e.target.value))}
                />
              </div>
              <div className="text-xs text-white/45 mt-1">
                Total size of your Notion content, in tokens. This only recurs when you re-index (new/changed pages).
              </div>
            </label>
          ) : null}

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
                            // Only the user's query text gets embedded per
                            // question — the retrieved context is already
                            // embedded, stored data being read back.
                            inputTokens:
                              users *
                              questionsPerUserPerDay *
                              ASSUMPTIONS.avgQueryTokensForEmbedding *
                              30,
                            pricing: OPENAI_EMBEDDING_PRICING,
                          });

                  const oneTimeIndexUsd =
                    costMode === "embedding"
                      ? embeddingMonthlyUsdFromTokens({
                          inputTokens: indexTokens,
                          pricing: OPENAI_EMBEDDING_PRICING,
                        })
                      : 0;

                  return (
                    <>
                      <span className="inline-block">{formatMoney(usd)}</span>
                      <ThinMoneyRow usd={usd} rate={usdToInr} />
                      {costMode === "embedding" ? (
                        <div className="text-sm font-normal text-white/60 mt-2">
                          + one-time indexing: {formatMoney(oneTimeIndexUsd)}{" "}
                          <span className="text-white/40">
                            ({formatMoneyInr(oneTimeIndexUsd, usdToInr)}) for ~{fmtNumber(indexTokens)} tokens
                          </span>
                        </div>
                      ) : null}
                      {infraMonthlyUsd > 0 ? (
                        <div className="text-sm font-normal text-white/60 mt-1">
                          + infra: {formatMoney(infraMonthlyUsd)}{" "}
                          <span className="text-white/40">({formatMoneyInr(infraMonthlyUsd, usdToInr)}) /mo</span>
                          <span className="mx-2 text-white/30">=</span>
                          <b className="text-white/85">{formatMoney(usd + infraMonthlyUsd)}</b>{" "}
                          <span className="text-white/40">total/mo</span>
                        </div>
                      ) : null}
                    </>
                  );
                })()}

              </div>

            </div>
            <div className="text-sm text-white/70">
              <div>
                {costMode === "llm"
                  ? "Sum of selected LLM i/p-o/p costs"
                  : "Recurring: query embeddings only. Indexing (stored content) is separate & one-time."}
              </div>
              <div className="text-xs text-white/40 mt-1">
                1 USD ≈ ₹{usdToInr.toFixed(2)}{" "}
                {usdToInrSource === "loading"
                  ? "(loading live rate…)"
                  : usdToInrSource === "fallback"
                    ? "(fallback rate — live fetch failed)"
                    : "(live rate)"}
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
                <ThinMoneyRow usd={llmUsage.totals.totalUsdEst} rate={usdToInr} />
                <div className="text-xs text-white/60 mt-1">Model priced: {llmUsage.modelId}</div>

              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-white/60">
              {llmUsageError ?? "No usage data found."}
            </div>
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
                        <ThinMoneyRow usd={u.totalUsdEst} rate={usdToInr} />

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
            <li>Avg query tokens embedded/question: {ASSUMPTIONS.avgQueryTokensForEmbedding} (recurring)</li>
            <li>Average retry/regenerate multiplier: {ASSUMPTIONS.avgRetryMultiplier}×</li>
            <li>Content indexing is a one-time embedding cost, not monthly — set separately above in Embedding cost mode.</li>
          </ul>
          <div className="mt-4 flex items-center gap-4">
            <label className="rounded-xl bg-black/20 border border-white/10 p-4 flex-1">
              <div className="text-xs text-white/55">Infra (EC2 + RDS etc.), monthly USD</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-white/70">$</span>
                <input
                  aria-label="infraMonthlyUsd"
                  className="w-full bg-transparent text-2xl font-bold outline-none"
                  type="number"
                  min={0}
                  step={1}
                  value={infraMonthlyUsd}
                  onChange={(e) => setInfraMonthlyUsd(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
              <div className="text-xs text-white/45 mt-1">
                Enter your actual monthly hosting bill — this isn't derived from usage, it's added on top of the API cost below.
              </div>
            </label>
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