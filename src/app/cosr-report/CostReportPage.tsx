"use client";

import { DEFAULT_COMPUTE_SIZING, DEFAULT_RDS_SIZING, estimateEc2Monthly, estimateRdsMonthly, formatMoney } from "./AwsComputeCost";
import { useMemo, useState } from "react";

type Model = {
  id: string;
  label: string;
  pricing: {
    inputPer1M: number; // $ / 1M input tokens
    outputPer1M: number; // $ / 1M output tokens
  };
};

const MODELS: Model[] = [
  {
    id: "gpt-4o-mini",
    label: "GPT-4o-mini (placeholder pricing)",
    pricing: {
      inputPer1M: 0.15,
      outputPer1M: 0.60,
    },
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1 (placeholder pricing)",
    pricing: {
      inputPer1M: 1.00,
      outputPer1M: 3.00,
    },
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat (placeholder pricing)",
    pricing: {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
    },
  },
  {
    id: "deepseek-4",
    label: "DeepSeek 4 (placeholder pricing)",
    pricing: {
      inputPer1M: 0.20,
      outputPer1M: 0.40,
    },
  },
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

function estimateCosts({
  inputTokens,
  outputTokens,
  pricing,
}: {
  inputTokens: number;
  outputTokens: number;
  pricing: { inputPer1M: number; outputPer1M: number };
}) {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return {
    inputCost,
    outputCost,
    total: inputCost + outputCost,
  };
}

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

  const daily = estimateCosts({
    inputTokens,
    outputTokens,
    pricing: model.pricing,
  });

  const monthly = {
    inputCost: daily.inputCost * 30,
    outputCost: daily.outputCost * 30,
    total: daily.total * 30,
  };

  const yearly = {
    inputCost: daily.inputCost * 365,
    outputCost: daily.outputCost * 365,
    total: daily.total * 365,
  };

  return {
    questionsPerDay,
    inputTokensDaily: inputTokens,
    completionTokensDaily: outputTokens,
    daily,
    monthly,
    yearly,
  };
}

export default function CostReportPage() {
  const [users, setUsers] = useState(2);
  const [questionsPerUserPerDay, setQuestionsPerUserPerDay] = useState(10);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([
    "gpt-4o-mini",
    "deepseek-chat",
  ]);

  const ec2Monthly = useMemo(
    () => estimateEc2Monthly({ hourlyUsd: DEFAULT_COMPUTE_SIZING.instance.hourlyUsd }).monthlyUsd,
    []
  );

  const rdsMonthly = useMemo(
    () => estimateRdsMonthly({ monthlyUsd: DEFAULT_RDS_SIZING.monthlyUsd }).monthlyUsd,
    []
  );

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

  const overallModelMonthlyCost = modelEstimates.reduce((sum, e) => sum + e.monthly.total, 0);
  const overallMonthlyCost = overallModelMonthlyCost + ec2Monthly + rdsMonthly;

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
              <div className="mt-2 text-xs text-white/45">
                Prices are placeholders—swap with your real provider pricing.
              </div>
            </div>
          </div>

          {/* Overall */}
          <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="text-xs text-white/70">Overall monthly cost</div>
                <div className="text-3xl font-extrabold mt-1">{formatMoney(overallMonthlyCost)}</div>
              </div>
              <div className="text-sm text-white/70">
                <div>
                  Models: <b className="text-white">{formatMoney(overallModelMonthlyCost)}</b>
                </div>
                <div>
                  Infra (EC2 {"+"} RDS): <b className="text-white">{formatMoney(ec2Monthly + rdsMonthly)}</b>
                </div>
              </div>
            </div>
          </div>
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
                    <div className="text-right">
                      <p className="text-xs text-white/50">Pricing</p>
                      <p className="text-sm font-semibold text-blue-200">
                        Input ${model.pricing.inputPer1M}/1M • Output ${model.pricing.outputPer1M}/1M
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Monthly</div>
                      <div className="text-2xl font-bold mt-1">{formatMoney(est.monthly.total)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {formatMoney(est.monthly.inputCost)} • Output {formatMoney(est.monthly.outputCost)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Daily</div>
                      <div className="text-2xl font-bold mt-1">{formatMoney(est.daily.total)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {formatMoney(est.daily.inputCost)} • Output {formatMoney(est.daily.outputCost)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-xs text-white/50">Yearly</div>
                      <div className="text-2xl font-bold mt-1">{formatMoney(est.yearly.total)}</div>
                      <div className="text-xs text-white/60 mt-1">
                        Input {formatMoney(est.yearly.inputCost)} • Output {formatMoney(est.yearly.outputCost)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-white/55">
                    Token inputs (daily): prompt+retrieval {fmtNumber(est.inputTokensDaily)} • completion {" "}
                    {fmtNumber(est.completionTokensDaily)}
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


