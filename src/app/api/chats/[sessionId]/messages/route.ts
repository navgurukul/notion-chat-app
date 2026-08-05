import { NextRequest, NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth";
import { query } from "@/lib/db";
import {
  addChatMessage,
  CHAT_HISTORY_LIMIT,
  clearChatMessages,
  deleteMessagesFrom,
  ensureSessionBelongsToUser,
  getOrCreateUser,
  listChatMessages,
} from "@/lib/chat/store";
import { sqlMetadataCache } from "@/lib/chat/cache";

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
    // Clear the SQL metadata cache for every message request in development mode to ensure instant updates
    if (process.env.NODE_ENV === "development") {
      sqlMetadataCache.clear();
    }

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

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const owned = await requireOwnedSession(context);
    if ("error" in owned) return owned.error;

    const { searchParams } = new URL(req.url);
    let messageId = searchParams.get("messageId");

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (messageId === "undefined" || !messageId || !uuidRegex.test(messageId)) {
      const lastMsgRows = await query<{ id: string }>(
        "SELECT id FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1",
        [owned.sessionId]
      );
      if (lastMsgRows.length > 0) {
        messageId = lastMsgRows[0].id;
      } else {
        messageId = null;
      }
    }

    if (messageId) {
      await deleteMessagesFrom(owned.sessionId, messageId);
      return NextResponse.json({ ok: true });
    }

    await clearChatMessages(owned.sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Clear/Delete chat messages API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to clear/delete chat messages" },
      { status: 500 },
    );
  }
}
