import { NextRequest, NextResponse } from "next/server";

import { isSessionResponse, requireSession } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/admin";
import { query } from "@/lib/db";
import { CHAT_PRICES } from "@/app/cost-report/AwsComputeCost";

function getPriceForModel(modelId: string) {
  return CHAT_PRICES[modelId];
}

export async function GET(_req: NextRequest) {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

    // This is admin-only data (every user's email + derived cost). The page
    // itself redirects non-admins, but that only guards the UI — this route
    // is hit directly by fetch(), so it needs its own check too.
    if (!isAdmin(session?.user?.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // What model to use for pricing?
    // This report is *historical* but we only store message text (no actual model id).
    // So we price based on the default UI models.
    const modelId =
      process.env.NEXT_PUBLIC_COST_REPORT_MODEL_ID ||
      process.env.OPENAI_CHAT_MODEL ||
      "gpt-4o-mini";

    const price = getPriceForModel(modelId);

    const rows = await query<{
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
      overall_total_user_messages: string;
      overall_total_bot_messages: string;
      overall_input_tokens_est: string;
      overall_output_tokens_est: string;
      overall_input_usd_est: string;
      overall_output_usd_est: string;
      overall_total_usd_est: string;
    }>(
      `
      WITH per_user AS (
        SELECT
          u.id AS user_id,
          u.email AS email,
          u.name AS name,
          COUNT(*) FILTER (WHERE cm.role = 'user') AS total_user_messages,
          COUNT(*) FILTER (WHERE cm.role = 'bot') AS total_bot_messages,
          SUM(CASE WHEN cm.role = 'user' THEN CEIL(LENGTH(cm.content) / 4.0) ELSE 0 END) AS input_tokens_est,
          SUM(CASE WHEN cm.role = 'bot' THEN CEIL(LENGTH(cm.content) / 4.0) ELSE 0 END) AS output_tokens_est
        FROM users u
        JOIN chat_sessions cs ON cs.user_id = u.id
        JOIN chat_messages cm ON cm.session_id = cs.id
        GROUP BY u.id, u.email, u.name
      )
      SELECT
        user_id, email, name,
        total_user_messages, total_bot_messages,
        input_tokens_est, output_tokens_est,

        CASE WHEN $1::text = 'missing' THEN '0' ELSE (input_tokens_est / 1000000.0) * $2 END AS input_usd_est,
        CASE WHEN $1::text = 'missing' THEN '0' ELSE (output_tokens_est / 1000000.0) * $3 END AS output_usd_est,
        CASE WHEN $1::text = 'missing' THEN '0' ELSE ((input_tokens_est + output_tokens_est) / 1000000.0) * ($2 + $3) END AS total_usd_est,

        -- Window functions run over ALL rows of per_user (before the LIMIT
        -- below is applied), so these totals cover every user, not just the
        -- top 50 returned to the client. One table scan instead of two.
        SUM(total_user_messages) OVER () AS overall_total_user_messages,
        SUM(total_bot_messages) OVER () AS overall_total_bot_messages,
        SUM(input_tokens_est) OVER () AS overall_input_tokens_est,
        SUM(output_tokens_est) OVER () AS overall_output_tokens_est,
        CASE WHEN $1::text = 'missing' THEN '0' ELSE (SUM(input_tokens_est) OVER () / 1000000.0) * $2 END AS overall_input_usd_est,
        CASE WHEN $1::text = 'missing' THEN '0' ELSE (SUM(output_tokens_est) OVER () / 1000000.0) * $3 END AS overall_output_usd_est,
        CASE WHEN $1::text = 'missing' THEN '0' ELSE ((SUM(input_tokens_est) OVER () + SUM(output_tokens_est) OVER ()) / 1000000.0) * ($2 + $3) END AS overall_total_usd_est

      FROM per_user
      ORDER BY GREATEST(input_tokens_est, output_tokens_est) DESC
      LIMIT 50;
      `,
      [
        price ? modelId : "missing",
        price?.inputPer1MTokensUsd ?? 0,
        price?.outputPer1MTokensUsd ?? 0,
      ],
    );

    const parsedUsers = rows
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

    // The overall_* columns carry the same value on every row (window
    // function with no PARTITION BY), so the first row has everything we
    // need. No rows at all just means no usage yet.
    const first = rows[0];
    const overallInputTokens = Number(first?.overall_input_tokens_est ?? 0);
    const overallOutputTokens = Number(first?.overall_output_tokens_est ?? 0);

    const totals = {
      inputTokensEst: overallInputTokens,
      outputTokensEst: overallOutputTokens,
      totalTokensEst: overallInputTokens + overallOutputTokens,
      inputUsdEst: Number(first?.overall_input_usd_est ?? 0),
      outputUsdEst: Number(first?.overall_output_usd_est ?? 0),
      totalUsdEst: Number(first?.overall_total_usd_est ?? 0),
      totalUserMessages: Number(first?.overall_total_user_messages ?? 0),
      totalBotMessages: Number(first?.overall_total_bot_messages ?? 0),
    };

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