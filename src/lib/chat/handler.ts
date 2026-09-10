import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { OPENAI_QUOTA_USER_MESSAGE, isOpenAIQuotaError } from "@/lib/ai/provider-errors";
import {
  ChatNotFoundError,
  ChatValidationError,
  runChatPipeline,
  type ChatRequestBody,
} from "@/lib/chat/pipeline";

/** HTTP entry for POST /api/chat — delegates to {@link runChatPipeline}. */
export async function handleChatPost(session: Session, body: ChatRequestBody, signal?: AbortSignal) {
  try {
    return await runChatPipeline(session, body, signal);
  } catch (error) {
    if (error instanceof ChatValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChatNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (isOpenAIQuotaError(error)) {
      return NextResponse.json(
        { error: OPENAI_QUOTA_USER_MESSAGE, answer: OPENAI_QUOTA_USER_MESSAGE },
        { status: 429 },
      );
    }
    throw error;
  }
}
