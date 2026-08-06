import "dotenv/config";
import "../src/lib/dns-hook";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { createChatSession, getSessionState, getOrCreateUser } from "../src/lib/chat/store";
import { query } from "../src/lib/db/postgres";
import { getPeopleDirectory } from "../src/lib/db/team-members";

async function main() {
  console.log("=== Testing Session State Carryover ===");

  const dir = await getPeopleDirectory();
  console.log("People in directory:", dir.map(p => p.name));

  // Mock session
  const mockSession = {
    user: {
      name: "Test User",
      email: "test.user@navgurukul.org"
    },
    expires: new Date(Date.now() + 3600 * 1000).toISOString()
  };

  // Get or create user
  const user = await getOrCreateUser(mockSession);
  console.log("Created/fetched test user:", user.id);

  // Create chat session
  const chatSession = await createChatSession(user.id, "Test Session State");
  const sessionId = chatSession.id;
  console.log("Created test session:", sessionId);

  try {
    // 1. First request resolving person
    console.log("\n--- Sending first request: 'Is there any task for Amruta ji?' ---");
    const res1 = await runChatPipeline(mockSession, {
      message: "Is there any task for Amruta ji?",
      sessionId
    });
    const body1 = await res1.json();
    console.log("Response 1 answer:", body1.answer);

    // Wait for async state update to execute
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify session state has Amruta
    const state = await getSessionState(sessionId);
    console.log("Updated Session State:", JSON.stringify(state, null, 2));

    if (state?.activePerson?.name !== "Amruta") {
      throw new Error(`Expected activePerson to be 'Amruta', got: '${state?.activePerson?.name}'`);
    }
    console.log("✅ State successfully saved activePerson as 'Amruta'!");

    // 2. Second request carrying over context (pronoun resolution)
    console.log("\n--- Sending follow-up: 'What projects is she working on?' ---");
    const res2 = await runChatPipeline(mockSession, {
      message: "What projects is she working on?",
      sessionId
    });
    const body2 = await res2.json();
    console.log("Response 2 answer:", body2.answer);

    console.log("\n✅ All session state carryover tests passed successfully!");
  } finally {
    // Clean up
    await query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
    await query("DELETE FROM chat_sessions WHERE id = $1", [sessionId]);
    console.log("\nCleaned up test session.");
  }
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
