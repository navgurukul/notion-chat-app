import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { createChatSession, getOrCreateUser, listChatSessions } from "@/lib/chat-store";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await getOrCreateUser(session);
    const sessions = await listChatSessions(user.id);
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("List chats API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list chats" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await getOrCreateUser(session);
    const chat = await createChatSession(user.id);
    return NextResponse.json({ session: chat });
  } catch (error) {
    console.error("Create chat API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create chat" },
      { status: 500 },
    );
  }
}
