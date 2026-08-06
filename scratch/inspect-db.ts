import "dotenv/config";
import { query } from "../src/lib/db";

import { extractLastEntityFromHistory } from "../src/lib/chat/pipeline/router";

import { resolveQuery } from "../src/lib/query/resolve-query";
import { getSessionState } from "../src/lib/chat/store";

import { runChatPipeline } from "../src/lib/chat/pipeline";
import { getOrCreateUser } from "../src/lib/chat/store";

async function main() {
  const session = {
    user: {
      name: "Test User",
      email: "test@example.com"
    },
    expires: "1"
  };

  const user = await getOrCreateUser(session);
  const userId = user.id;

  const sessionId = "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d";
  await query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
  await query("DELETE FROM chat_sessions WHERE id = $1", [sessionId]);
  
  await query(
    `INSERT INTO chat_sessions (id, user_id, state, created_at, updated_at) 
     VALUES ($1, $2, '{}'::jsonb, now(), now())`,
    [sessionId, userId]
  );

  console.log("--- TEST 1: Query for Aadarsh ---");
  await runChatPipeline(session, {
    sessionId,
    message: "list the task for aadarsh",
    history: []
  });

  const dbMessages = await query<{ role: string, content: string }>(
    "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId]
  );
  const history1 = dbMessages.map(m => ({ role: m.role as "user" | "bot", content: m.content }));

  console.log("\n--- TEST 2: Follow-up query for 'him' (should resolve to Aadarsh) ---");
  await runChatPipeline(session, {
    sessionId,
    message: "list the task for him",
    history: history1
  });

  const dbMessages2 = await query<{ role: string, content: string }>(
    "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId]
  );
  const history2 = dbMessages2.map(m => ({ role: m.role as "user" | "bot", content: m.content }));

  console.log("\n--- TEST 3: Query for Mahendra ---");
  await runChatPipeline(session, {
    sessionId,
    message: "list the task for mahendra",
    history: history2
  });

  const state = await getSessionState(sessionId);
  console.log("\nSession State in DB after TEST 3:", state);
}
main().catch(console.error);
