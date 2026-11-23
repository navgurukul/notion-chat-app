import { query } from "@/lib/db/postgres";

export async function revokeChatShareLink(
  sessionId: string,
  userId: string,
): Promise<{ revoked: boolean }> {
  const ownedChat = await query<{ id: string }>(
    `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  if (ownedChat.length === 0) {
    throw new Error("Chat not found");
  }

  const revokedShare = await query<{ id: string }>(
    `UPDATE chat_shares
     SET revoked_at = NOW()
     WHERE session_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId],
  );

  return { revoked: revokedShare.length > 0 };
}
