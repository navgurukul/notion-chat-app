import { NextRequest, NextResponse } from "next/server";

import { isSessionResponse, requireSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { CHAT_PRICES } from "@/app/cost-report/AwsComputeCost";

function ceilDiv4(n: number) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 4);
}

function getPriceForModel(modelId: string) {
  return CHAT_PRICES[modelId];
}

function estimateTokensFromText(content: string) {
  // Repo heuristic used for chunking: token ≈ chars / 4
  return ceilDiv4((content ?? "").length);
}

export async function GET(_req: NextRequest) {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

    // What model to use for pricing?
    // This report is *historical* but we only store message text (no actual model id).
    // So we price based on the default UI models.
    const modelId =
      process.env.NEXT_PUBLIC_COST_REPORT_MODEL_ID ||
      process.env.OPENAI_CHAT_MODEL ||
      "gpt-4o-mini";

    const price = getPriceForModel(modelId);

    const users = await query<{
      user_id: string;
      email: string;
      name: string | null;
      total_user_messages: string;
      total_bot_messages: string;
      input_tokens_est: string;
      output_tokens_est: string;
      input_usd_est: string;
      output_usd_est: string;
      total_usd_est: string;
    }>(
      `
      SELECT
        u.id AS user_id,
        u.email AS email,
        u.name AS name,

        COUNT(*) FILTER (WHERE cm.role = 'user') AS total_user_messages,
        COUNT(*) FILTER (WHERE cm.role = 'bot') AS total_bot_messages,

        SUM(
          CASE WHEN cm.role = 'user'
            THEN CEIL(LENGTH(cm.content) / 4.0)
            ELSE 0
          END
        ) AS input_tokens_est,

        SUM(
          CASE WHEN cm.role = 'bot'
            THEN CEIL(LENGTH(cm.content) / 4.0)
            ELSE 0
          END
        ) AS output_tokens_est,

        -- USD estimates if we have pricing; otherwise 0.
        CASE
          WHEN $1::text = 'missing' THEN '0'
          ELSE (
            SUM(
              CASE WHEN cm.role = 'user'
                THEN CEIL(LENGTH(cm.content) / 4.0)
                ELSE 0
              END
            ) / 1000000.0
          ) * $2
        END AS input_usd_est,

        CASE
          WHEN $1::text = 'missing' THEN '0'
          ELSE (
            SUM(
              CASE WHEN cm.role = 'bot'
                THEN CEIL(LENGTH(cm.content) / 4.0)
                ELSE 0
              END
            ) / 1000000.0
          ) * $3
        END AS output_usd_est,

        CASE
          WHEN $1::text = 'missing' THEN '0'
          ELSE (
            (
              SUM(
                CASE WHEN cm.role = 'user'
                  THEN CEIL(LENGTH(cm.content) / 4.0)
                  ELSE 0
                END
              )
              +
              SUM(
                CASE WHEN cm.role = 'bot'
                  THEN CEIL(LENGTH(cm.content) / 4.0)
                  ELSE 0
                END
              )
            ) / 1000000.0
          ) * ($2 + $3)
        END AS total_usd_est

      FROM users u
      JOIN chat_sessions cs ON cs.user_id = u.id
      JOIN chat_messages cm ON cm.session_id = cs.id
      GROUP BY u.id, u.email, u.name
      ORDER BY GREATEST(
        SUM(CASE WHEN cm.role = 'user' THEN CEIL(LENGTH(cm.content) / 4.0) ELSE 0 END),
        SUM(CASE WHEN cm.role = 'bot' THEN CEIL(LENGTH(cm.content) / 4.0) ELSE 0 END)
      ) DESC
      LIMIT 50;
      `,
      [
        price ? modelId : "missing",
        price?.inputPer1MTokensUsd ?? 0,
        price?.outputPer1MTokensUsd ?? 0,
      ],
    );

    const parsedUsers = users
      .map((u) => {
        const inputTokens = Number(u.input_tokens_est);
        const outputTokens = Number(u.output_tokens_est);
        const inputUsd = Number(u.input_usd_est);
        const outputUsd = Number(u.output_usd_est);
        const totalUsd = Number(u.total_usd_est);

        return {
          userId: u.user_id,
          email: u.email,
          name: u.name,
          totalUserMessages: Number(u.total_user_messages),
          totalBotMessages: Number(u.total_bot_messages),
          inputTokensEst: inputTokens,
          outputTokensEst: outputTokens,
          totalTokensEst: inputTokens + outputTokens,
          inputUsdEst: inputUsd,
          outputUsdEst: outputUsd,
          totalUsdEst: totalUsd,
        };
      })
      .filter((u) => u.totalTokensEst > 0);

    const totals = parsedUsers.reduce(
      (acc, u) => {
        acc.inputTokensEst += u.inputTokensEst;
        acc.outputTokensEst += u.outputTokensEst;
        acc.totalTokensEst += u.totalTokensEst;
        acc.inputUsdEst += u.inputUsdEst;
        acc.outputUsdEst += u.outputUsdEst;
        acc.totalUsdEst += u.totalUsdEst;
        acc.totalUserMessages += u.totalUserMessages;
        acc.totalBotMessages += u.totalBotMessages;
        return acc;
      },
      {
        inputTokensEst: 0,
        outputTokensEst: 0,
        totalTokensEst: 0,
        inputUsdEst: 0,
        outputUsdEst: 0,
        totalUsdEst: 0,
        totalUserMessages: 0,
        totalBotMessages: 0,
      },
    );

    return NextResponse.json({
      modelId,
      totals,
      users: parsedUsers,
    });
  } catch (error) {
    console.error("LLM usage route error:", error);
    return NextResponse.json(
      { error: "Failed to fetch LLM usage" },
      { status: 500 },
    );
  }
}

