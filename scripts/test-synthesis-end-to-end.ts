import "dotenv/config";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { query } from "../src/lib/db";
import type { Session } from "next-auth";

async function test() {
  const users = await query<{ email: string; name: string }>(
    "SELECT email, name FROM users WHERE name ILIKE '%tamanna%' LIMIT 1"
  );
  
  const targetUser = users[0] || { email: "tamanna@navgurukul.org", name: "Tamanna a" };
  console.log("Mocking session for user:", targetUser);
  
  const mockSession: Session = {
    user: {
      name: targetUser.name,
      email: targetUser.email,
    },
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  const body = {
    message: "what my role in ng? based on my tasks",
    history: [],
    sessionId: null
  };

  console.log("\nRunning chat pipeline with query:", body.message);
  const response = await runChatPipeline(mockSession, body);

  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("application/json")) {
    const json = await response.json();
    console.log("\n--- CHATBOT RESPONSE (JSON) ---");
    console.log(json.answer);
    console.log("------------------------");
  } else {
    // It's a streamed response, let's read the stream
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    console.log("\n--- CHATBOT RESPONSE (STREAMED) ---");
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
      }
    }
    console.log("\n-----------------------------------");
  }
}

test().catch(console.error);
