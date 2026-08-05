import "dotenv/config";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { query } from "../src/lib/db";
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
  const res1 = await runChatPipeline(session, {
    sessionId,
    message: "list the task for aadarsh",
    history: []
  });
  const text1 = await res1.text();
  console.log("Res 1 length:", text1.length);
  console.log("Res 1 contains Aadarsh Kumar:", text1.includes("Aadarsh Kumar"));

  console.log("\n--- TEST 2: Follow-up query for 'him' (should resolve to Aadarsh) ---");
  // Fetch messages to build history context
  const dbMessages = await query<{ role: string, content: string }>(
    "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId]
  );
  const history1 = dbMessages.map(m => ({ role: m.role as "user" | "bot", content: m.content }));

  const res2 = await runChatPipeline(session, {
    sessionId,
    message: "list the task for him",
    history: history1
  });
  const text2 = await res2.text();
  console.log("Res 2 length:", text2.length);
  console.log("Res 2 contains Aadarsh Kumar:", text2.includes("Aadarsh Kumar"));

  console.log("\n--- TEST 3: Query for Mahendra ---");
  const res3 = await runChatPipeline(session, {
    sessionId,
    message: "list the task for mahendra",
    history: history1
  });
  const text3 = await res3.text();
  console.log("Res 3 length:", text3.length);
  console.log("Res 3 contains Mahendra:", text3.includes("Mahendra"));

  console.log("\n--- TEST 4: Follow-up query for 'him' (should resolve to Mahendra) ---");
  const dbMessages2 = await query<{ role: string, content: string }>(
    "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
    [sessionId]
  );
  const history2 = dbMessages2.map(m => ({ role: m.role as "user" | "bot", content: m.content }));

  const res4 = await runChatPipeline(session, {
    sessionId,
    message: "list the task for him",
    history: history2
  });
  const text4 = await res4.text();
  console.log("Res 4 length:", text4.length);
  console.log("Res 4 contains Mahendra:", text4.includes("Mahendra"));

  process.exit(0);
}

main().catch(console.error);
