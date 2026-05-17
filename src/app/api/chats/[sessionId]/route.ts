import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { deleteChatSession, ensureSessionBelongsToUser, getOrCreateUser } from "@/lib/chat-store";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await getOrCreateUser(session);
    const { sessionId } = await context.params;

    const ownsSession = await ensureSessionBelongsToUser(sessionId, user.id);
    if (!ownsSession) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    const deleted = await deleteChatSession(sessionId, user.id);
    if (!deleted) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete chat API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete chat" },
      { status: 500 },
    );
  }
}
