import { NextRequest, NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth";
import { handleChatPost } from "@/lib/chat/handler";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

    const body = await req.json();
    return handleChatPost(session, body);
  } catch (error) {
    console.error("Chat API Error:", error);
    const { isGeminiQuotaError, GEMINI_QUOTA_USER_MESSAGE } = await import(
      "@/lib/ai/provider-errors"
    );
    if (isGeminiQuotaError(error)) {
      return NextResponse.json(
        { error: GEMINI_QUOTA_USER_MESSAGE, answer: GEMINI_QUOTA_USER_MESSAGE },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "Failed to get response" }, { status: 500 });
  }
}
