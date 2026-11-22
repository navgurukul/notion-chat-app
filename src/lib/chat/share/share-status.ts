import { query } from "@/lib/db/postgres";

export async function getChatShareStatus(
  sessionId: string,
  userId: string,
): Promise<{ shared: false } | { shared: true; sharedAt: Date }> {
  const ownedChat = await query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (ownedChat.length === 0) {
    throw new Error("Chat not found");
  }

  const activeShare = await query<{ created_at: Date }>(
    `SELECT created_at FROM chat_shares WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );

  if (activeShare.length === 0) {
    return { shared: false };
  }

  return { shared: true, sharedAt: activeShare[0].created_at };
}
