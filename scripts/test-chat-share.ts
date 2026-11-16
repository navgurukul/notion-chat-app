/**
 * Integration checks for chat share helpers against the configured database.
 * Run with: npx tsx scripts/test-chat-share.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createOrReshareChatLink } from "@/lib/chat/share-link";
import { getChatShareStatus } from "@/lib/chat/share-status";
import { revokeChatShareLink } from "@/lib/chat/share-revoke";
import { hashShareToken } from "@/lib/chat/share-token";
import { pool, query } from "@/lib/db/postgres";

const marker = `chat-share-test-${randomUUID()}`;
const userIds: string[] = [];
const chatIds: string[] = [];
let checks = 0;

function check(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function expectChatNotFound(action: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  check(caught instanceof Error && caught.message === "Chat not found", "non-owner receives Chat not found");
}

async function createUser(suffix: string) {
  const rows = await query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [`${marker}-${suffix}@example.test`, `${marker}-${suffix}`],
  );
  userIds.push(rows[0].id);
  return rows[0].id;
}

async function createChat(userId: string, suffix: string, messages: Array<{ role: string; content: string; emotion?: string; feedback?: string }> = []) {
  const sessions = await query<{ id: string }>(
    `INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, `${marker}-${suffix}`],
  );
  const sessionId = sessions[0].id;
  chatIds.push(sessionId);

  for (const [index, message] of messages.entries()) {
    await query(
      `INSERT INTO chat_messages (session_id, role, content, emotion, feedback, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 millisecond'))`,
      [sessionId, message.role, message.content, message.emotion ?? null, message.feedback ?? null, index],
    );
  }
  return sessionId;
}

async function run() {
  const ownerId = await createUser("owner");
  const otherUserId = await createUser("other");

  const ownedChat = await createChat(ownerId, "main", [
    { role: "user", content: "A private question", emotion: "curious", feedback: "positive" },
    { role: "assistant", content: "A private answer", emotion: "calm", feedback: "negative" },
  ]);
  const emptyChat = await createChat(ownerId, "empty");

  await expectChatNotFound(() => createOrReshareChatLink(ownedChat, otherUserId));

  let emptyError: unknown;
  try {
    await createOrReshareChatLink(emptyChat, ownerId);
  } catch (error) {
    emptyError = error;
  }
  check(emptyError instanceof Error && emptyError.message === "Cannot share a chat with no messages", "empty chat is rejected");
  const emptyLinks = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM chat_shares WHERE session_id = $1`, [emptyChat]);
  check(emptyLinks[0].count === "0", "empty chat creates no share link");

  const beforeStatus = await getChatShareStatus(ownedChat, ownerId);
  check(beforeStatus.shared === false, "status is false before sharing");
  await expectChatNotFound(() => getChatShareStatus(ownedChat, otherUserId));

  const first = await createOrReshareChatLink(ownedChat, ownerId);
  check(first.alreadyShared === false && typeof first.token === "string", "first share returns a token");
  const firstToken = first.alreadyShared ? "" : first.token;
  const firstHash = hashShareToken(firstToken);
  const storedFirst = await query<{ token_hash: string }>(`SELECT token_hash FROM chat_shares WHERE session_id = $1`, [ownedChat]);
  check(storedFirst.length === 1 && storedFirst[0].token_hash === firstHash, "only the token hash is stored");
  check(storedFirst.every((row) => row.token_hash !== firstToken), "raw token is never stored");

  const again = await createOrReshareChatLink(ownedChat, ownerId);
  check(again.alreadyShared === true && !("token" in again), "second share returns alreadyShared without a token");

  const afterStatus = await getChatShareStatus(ownedChat, ownerId);
  check(afterStatus.shared === true && afterStatus.sharedAt instanceof Date, "status is true after sharing with sharedAt");

  const reshared = await createOrReshareChatLink(ownedChat, ownerId, true);
  check(reshared.alreadyShared === false && typeof reshared.token === "string", "reshare returns a new token");
  const secondToken = reshared.alreadyShared ? "" : reshared.token;
  check(secondToken !== firstToken, "reshare returns a different token");
  const shareRows = await query<{ token_hash: string; revoked_at: Date | null }>(
    `SELECT token_hash, revoked_at FROM chat_shares WHERE session_id = $1 ORDER BY created_at, id`,
    [ownedChat],
  );
  check(shareRows.length === 2 && shareRows[0].revoked_at instanceof Date, "reshare revokes the old row");
  check(shareRows.filter((row) => row.revoked_at === null).length === 1, "reshare leaves exactly one active link");
  check(shareRows.some((row) => row.token_hash === hashShareToken(secondToken)), "new token hash is stored");

  const snapshot = await query<Record<string, unknown>>(
    `SELECT role, content FROM shared_chat_messages WHERE share_id = (
       SELECT id FROM chat_shares WHERE session_id = $1 AND revoked_at IS NULL
     ) ORDER BY created_at`,
    [ownedChat],
  );
  check(snapshot.length === 2, "snapshot has the same number of messages");
  check(snapshot[0].role === "user" && snapshot[0].content === "A private question", "snapshot preserves first role and content");
  check(snapshot[1].role === "assistant" && snapshot[1].content === "A private answer", "snapshot preserves second role and content");
  const snapshotColumns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shared_chat_messages'`,
  );
  check(
    snapshotColumns.map(({ column_name }) => column_name).sort().join(",") === "content,created_at,id,role,share_id",
    "snapshot table has exactly the expected columns",
  );

  const concurrentChat = await createChat(ownerId, "concurrent", [{ role: "user", content: "Concurrent sharing" }]);
  const concurrentResults = await Promise.all([
    createOrReshareChatLink(concurrentChat, ownerId),
    createOrReshareChatLink(concurrentChat, ownerId),
  ]);
  check(concurrentResults.filter((result) => result.alreadyShared === false).length === 1, "concurrent fresh shares return one new link");
  const concurrentLinks = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM chat_shares WHERE session_id = $1 AND revoked_at IS NULL`,
    [concurrentChat],
  );
  check(concurrentLinks[0].count === "1", "concurrent fresh shares create one active link");

  const revokeChat = await createChat(ownerId, "revoke", [{ role: "user", content: "Revoke this" }]);
  await createOrReshareChatLink(revokeChat, ownerId);
  const firstRevoke = await revokeChatShareLink(revokeChat, ownerId);
  const secondRevoke = await revokeChatShareLink(revokeChat, ownerId);
  check(firstRevoke.revoked === true, "first revoke returns true");
  check(secondRevoke.revoked === false, "second revoke returns false");
  const revokedStatus = await getChatShareStatus(revokeChat, ownerId);
  check(revokedStatus.shared === false, "status is false after revoke");
  await expectChatNotFound(() => revokeChatShareLink(revokeChat, otherUserId));

  const deleteChat = await createChat(ownerId, "delete", [{ role: "user", content: "Delete cascade" }]);
  await createOrReshareChatLink(deleteChat, ownerId);
  const beforeDelete = await query<{ shares: string; messages: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM chat_shares WHERE session_id = $1) AS shares,
       (SELECT COUNT(*)::text FROM shared_chat_messages WHERE share_id IN (SELECT id FROM chat_shares WHERE session_id = $1)) AS messages`,
    [deleteChat],
  );
  check(beforeDelete[0].shares === "1" && beforeDelete[0].messages === "1", "delete fixture has share and snapshot rows");
  await query(`DELETE FROM chat_sessions WHERE id = $1`, [deleteChat]);
  const afterDelete = await query<{ shares: string; messages: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM chat_shares WHERE session_id = $1) AS shares,
       (SELECT COUNT(*)::text FROM shared_chat_messages WHERE share_id IN (SELECT id FROM chat_shares WHERE session_id = $1)) AS messages`,
    [deleteChat],
  );
  check(afterDelete[0].shares === "0" && afterDelete[0].messages === "0", "deleting chat removes share and snapshot rows");
}

async function main() {
  let testError: unknown;
  try {
    await run();
    console.log(`All ${checks} chat-share checks passed.`);
  } catch (error) {
    testError = error;
  } finally {
    try {
      if (userIds.length > 0) {
        await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
      }
      // Also cover fixtures if user creation succeeded but was interrupted before the IDs were recorded.
      await query(`DELETE FROM users WHERE email LIKE $1`, [`${marker}-%@example.test`]);
      if (chatIds.length > 0) {
        await query(`DELETE FROM chat_sessions WHERE id = ANY($1::uuid[])`, [chatIds]);
      }
    } catch (cleanupError) {
      testError ??= cleanupError;
    } finally {
      await pool.end();
    }
  }

  if (testError) throw testError;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Chat-share checks failed");
  process.exitCode = 1;
});
