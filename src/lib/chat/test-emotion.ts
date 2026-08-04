import "dotenv/config";
import { runChatPipeline } from "./pipeline";
import type { Session } from "next-auth";

const mockSession: Session = {
  user: {
    email: "test@example.com",
    name: "Test User",
  },
  expires: new Date(Date.now() + 3600000).toISOString(),
};

async function testEmotionQuery(message: string) {
  console.log(`\n=================== Testing: "${message}" ===================`);
  try {
    const res = await runChatPipeline(mockSession, {
      message,
      history: [],
    });

    if (res instanceof Response) {
      const userEmotion = res.headers.get("X-User-Emotion");
      console.log(`Detected User Emotion (from X-User-Emotion header): ${userEmotion}`);

      console.log("Reading response stream...");
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        let answer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          answer += decoder.decode(value);
        }
        console.log("AI Answer:", answer);
      }
    } else {
      console.log("Response (JSON):", JSON.stringify(res));
    }
  } catch (err) {
    console.error("Error running pipeline:", err);
  }
}

async function main() {
  // Test funny mood
  await testEmotionQuery("knock knock! who is there? A developer. Developer who? A developer who wants to know about the leave policy!");

  // Test happy mood
  await testEmotionQuery("Yay, we finally finished the payments module! Tell me about the architecture.");

  // Test frustrated mood
  await testEmotionQuery("Ugh, why is the payments documentation so hard to find? Can you tell me why we chose this architecture?");
}

main().catch(console.error);
