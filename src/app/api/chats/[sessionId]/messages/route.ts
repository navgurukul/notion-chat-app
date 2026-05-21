import { NextRequest, NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/api-auth";
import {
  addChatMessage,
  CHAT_HISTORY_LIMIT,
  clearChatMessages,
  ensureSessionBelongsToUser,
  getOrCreateUser,
  listChatMessages,
} from "@/lib/chat-store";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

async function requireOwnedSession(context: RouteContext) {
  const session = await requireSession();
  if (isSessionResponse(session)) return { error: session };

  const user = await getOrCreateUser(session);
  const { sessionId } = await context.params;
  const ownsSession = await ensureSessionBelongsToUser(sessionId, user.id);
  if (!ownsSession) return { error: NextResponse.json({ error: "Chat not found" }, { status: 404 }) };

  return { sessionId };
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const owned = await requireOwnedSession(context);
    if ("error" in owned) return owned.error;

    const messages = await listChatMessages(owned.sessionId, CHAT_HISTORY_LIMIT);
    return NextResponse.json({ messages });
  } catch (error) {
    console.error("List chat messages API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list chat messages" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const owned = await requireOwnedSession(context);
    if ("error" in owned) return owned.error;

    const { role, content } = await req.json();
    if ((role !== "user" && role !== "bot") || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const message = await addChatMessage(owned.sessionId, role, content.trim());
    return NextResponse.json({ message });
  } catch (error) {
    console.error("Create chat message API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create chat message" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const owned = await requireOwnedSession(context);
    if ("error" in owned) return owned.error;

    await clearChatMessages(owned.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Clear chat messages API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to clear chat messages" },
      { status: 500 },
    );
  }
}
