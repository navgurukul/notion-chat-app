import "@/lib/dns-hook";
import { NextRequest, NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth";
import { handleChatPost } from "@/lib/chat/handler";
import { checkRateLimit } from "@/lib/shared/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();

    if (isSessionResponse(session)) {
      return session;
    }

    const userKey = session.user?.email ?? "anonymous";

    const rateLimitResult = checkRateLimit(userKey);

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          error: `Too many requests. Please try again in ${rateLimitResult.retryAfterSeconds} seconds.`,
          retryAfter: rateLimitResult.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              rateLimitResult.retryAfterSeconds,
            ),
          },
        },
      );
    }

    const body = await req.json();

    return handleChatPost(session, body, req.signal);
  } catch (error) {
    console.error("Chat API Error:", error);

    const { isOpenAIQuotaError, OPENAI_QUOTA_USER_MESSAGE } =
      await import("@/lib/ai/provider-errors");

    if (isOpenAIQuotaError(error)) {
      return NextResponse.json(
        {
          error: OPENAI_QUOTA_USER_MESSAGE,
          answer: OPENAI_QUOTA_USER_MESSAGE,
        },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: "Failed to get response" },
      { status: 500 },
    );
  }
}