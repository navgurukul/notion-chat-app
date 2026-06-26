import "dotenv/config";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import type { Session } from "next-auth";

const mockSession: Session = {
  user: {
    email: "test@example.com",
    name: "Test User",
  },
  expires: new Date(Date.now() + 3600000).toISOString(),
};

async function testQuery(message: string, isStream = false) {
  console.log(`\n=================== Testing: "${message}" ===================`);
  try {
    const res = await runChatPipeline(mockSession, {
      message,
      history: [],
    });

    if (res instanceof Response) {
      if (isStream) {
        console.log("Reading streamed response...");
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            process.stdout.write(decoder.decode(value));
          }
          console.log();
        }
      } else {
        const text = await res.text();
        console.log("Response text:", text);
      }
    } else {
      console.log("Response (JSON):", JSON.stringify(res));
    }
  } catch (err) {
    console.error("Error running pipeline:", err);
  }
}

async function main() {
  // Test RAG semantic path (requires streaming response)
  await testQuery("Why did we choose this architecture for the payments module?", true);
}

main().catch(console.error);
