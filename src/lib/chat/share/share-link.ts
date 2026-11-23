import { getClient } from "@/lib/db/postgres";
import { generateShareToken, hashShareToken } from "./share-token";

export async function createOrReshareChatLink(
  sessionId: string,
  userId: string,
  reshare = false,
): Promise<{ alreadyShared: true } | { alreadyShared: false; token: string }> {
  const client = await getClient();

  try {
    await client.query("BEGIN");

    const ownedChat = await client.query(
      `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [sessionId, userId],
    );
    if (ownedChat.rowCount === 0) {
      throw new Error("Chat not found");
    }

    const activeShare = await client.query<{ id: string }>(
      `SELECT id FROM chat_shares WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );

    const messages = await client.query(
      `SELECT 1 FROM chat_messages WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    if (messages.rowCount === 0) {
      throw new Error("Cannot share a chat with no messages");
    }

    if (activeShare.rowCount && !reshare) {
      await client.query("COMMIT");
      return { alreadyShared: true };
    }

    if (activeShare.rowCount) {
      await client.query(
        `UPDATE chat_shares SET revoked_at = NOW() WHERE id = $1`,
        [activeShare.rows[0].id],
      );
    }

    const token = generateShareToken();
    const share = await client.query<{ id: string }>(
      `INSERT INTO chat_shares (session_id, token_hash) VALUES ($1, $2) RETURNING id`,
      [sessionId, hashShareToken(token)],
    );

    await client.query(
      `INSERT INTO shared_chat_messages (share_id, role, content, created_at)
       SELECT $1, role, content, created_at
       FROM chat_messages
       WHERE session_id = $2
       ORDER BY created_at ASC`,
      [share.rows[0].id, sessionId],
    );

    await client.query("COMMIT");
    return { alreadyShared: false, token };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
