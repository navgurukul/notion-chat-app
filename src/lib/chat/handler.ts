import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import {
  ChatNotFoundError,
  ChatValidationError,
  runChatPipeline,
  type ChatRequestBody,
} from "@/lib/chat/pipeline";

/** HTTP entry for POST /api/chat — delegates to {@link runChatPipeline}. */
export async function handleChatPost(session: Session, body: ChatRequestBody) {
  try {
    return await runChatPipeline(session, body);
  } catch (error) {
    if (error instanceof ChatValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChatNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
