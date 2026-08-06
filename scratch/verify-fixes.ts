import "dotenv/config";
import "../src/lib/dns-hook";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { createChatSession, getOrCreateUser } from "../src/lib/chat/store";

async function parseResponse(res: Response): Promise<{ answer: string }> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  }
  return { answer: text };
}

async function main() {
  const mockSession = {
    user: {
      name: "Test User",
      email: "test.user@navgurukul.org"
    },
    expires: new Date(Date.now() + 3600 * 1000).toISOString()
  };

  const user = await getOrCreateUser(mockSession);
  const chatSession = await createChatSession(user.id, "Verification Test Session");
  const sessionId = chatSession.id;

  console.log("\n=== Query 1: \"i am not feelingwell today\" ===");
  const res1 = await runChatPipeline(mockSession, {
    message: "i am not feelingwell today",
    sessionId
  });
  const body1 = await parseResponse(res1);
  console.log("Answer 1:", body1.answer);

  console.log("\n=== Query 2: \"anu role , but task shivash is working on...\" ===");
  const res2 = await runChatPipeline(mockSession, {
    message: "anu role , but task shivash is working on...",
    sessionId
  });
  const body2 = await parseResponse(res2);
  console.log("Answer 2:", body2.answer);
}

main().catch(console.error);
