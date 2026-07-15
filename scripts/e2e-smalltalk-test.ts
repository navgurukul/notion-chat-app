import "dotenv/config";
import "../src/lib/dns-hook";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { createChatSession, getOrCreateUser } from "../src/lib/chat/store";
import { query } from "../src/lib/db/postgres";

// Mock user session configs
const mockSessionNoName = {
  user: {
    email: "tester.noname@navgurukul.org"
  },
  expires: new Date(Date.now() + 3600 * 1000).toISOString()
};

const mockSessionWithName = {
  user: {
    name: "John Doe",
    email: "john.doe@navgurukul.org"
  },
  expires: new Date(Date.now() + 3600 * 1000).toISOString()
};

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

type ChatHistoryItem = { role: "user" | "bot"; content: string };

// Global results accumulator
const results: { test: string; ok: boolean; message: string }[] = [];

function assert(testName: string, condition: boolean, message: string) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    results.push({ test: testName, ok: true, message });
  } else {
    console.error(`❌ FAIL: ${testName} - ${message}`);
    results.push({ test: testName, ok: false, message });
  }
}

async function main() {
  console.log("=== STARTING END-TO-END SMALL TALK FUNCTIONALITY TEST ===");

  // Intercept telemetry logs to inspect executing paths and LLM call counts
  const originalLog = console.log;
  let latestTrace: any = null;

  console.log = function (...args: any[]) {
    if (args[0] === "[pipeline-telemetry]" && typeof args[1] === "string") {
      try {
        latestTrace = JSON.parse(args[1]);
      } catch (e) {}
    } else {
      for (const arg of args) {
        if (typeof arg === "string" && arg.includes("[pipeline-telemetry]")) {
          try {
            const jsonStr = arg.replace("[pipeline-telemetry]", "").trim();
            latestTrace = JSON.parse(jsonStr);
          } catch (e) {}
        }
      }
    }
    originalLog.apply(console, args);
  };

  let testSessionId: string | null = null;
  const history: ChatHistoryItem[] = [];

  try {
    const user = await getOrCreateUser(mockSessionWithName);
    const chatSession = await createChatSession(user.id, "E2E Small Talk Test Session");
    testSessionId = chatSession.id;

    // ----------------------------------------------------
    // 1. Test Regex Fast Paths
    // ----------------------------------------------------
    console.log("\n--- Category 1: Regex Fast Paths (No Name) ---");
    const fastPathCases = [
      { msg: "hello", type: "greeting", expectKeywords: ["NavGurukul", "assistant", "Notion", "help", "look up"] },
      { msg: "thanks a lot", type: "thanks", expectKeywords: ["welcome", "Notion", "help", "look up"] },
      { msg: "bye now", type: "bye", expectKeywords: ["Goodbye", "later", "care", "ready"] },
      { msg: "what can you do", type: "help", expectKeywords: ["find", "pages", "tasks", "status", "Notion"] },
      { msg: "are you a bot", type: "identity", expectKeywords: ["assistant", "Notion", " workplace", "documentation", "query"] },
      { msg: "whats up", type: "howAreYou", expectKeywords: ["great", "doing well", "good", "ready"] }
    ];

    for (const tc of fastPathCases) {
      latestTrace = null;
      const res = await runChatPipeline(mockSessionNoName, {
        message: tc.msg,
        sessionId: testSessionId,
        history: [] // empty history to prevent repeat triggers
      });
      const parsed = await parseResponse(res);

      assert(
        `Fast-path for "${tc.msg}" (${tc.type})`,
        latestTrace && latestTrace.executionPath === "Smalltalk/Fastpath" && latestTrace.llmCalls === 0,
        `Expected executionPath "Smalltalk/Fastpath" and 0 LLM calls. Got path: ${latestTrace?.executionPath}, LLM calls: ${latestTrace?.llmCalls}`
      );

      const matchedKeyword = tc.expectKeywords.some(keyword => 
        parsed.answer.toLowerCase().includes(keyword.toLowerCase())
      );
      assert(
        `Response content check for "${tc.msg}"`,
        matchedKeyword,
        `Expected response to contain smalltalk variation keywords. Got: "${parsed.answer}"`
      );
    }

    // ----------------------------------------------------
    // 2. Test User Name Template Replacement
    // ----------------------------------------------------
    console.log("\n--- Category 2: Template substitution with user name ---");
    latestTrace = null;
    const resWithName = await runChatPipeline(mockSessionWithName, {
      message: "hi",
      sessionId: testSessionId,
      history: []
    });
    const parsedWithName = await parseResponse(resWithName);

    assert(
      "Greeting formats user name",
      parsedWithName.answer.includes("John Doe"),
      `Expected response to contain "John Doe". Got: "${parsedWithName.answer}"`
    );

    // Accumulate the first greeting into history
    history.push({ role: "user", content: "hi" });
    history.push({ role: "bot", content: parsedWithName.answer });

    // ----------------------------------------------------
    // 3. Test Repetitive Small Talk Detection & Warm Reply
    // ----------------------------------------------------
    console.log("\n--- Category 3: Repeat Message Limit & Warm Reply ---");
    
    // Send a 2nd greeting
    console.log("Sending 2nd greeting...");
    latestTrace = null;
    const resRep2 = await runChatPipeline(mockSessionWithName, {
      message: "hi",
      sessionId: testSessionId,
      history: history
    });
    const parsedRep2 = await parseResponse(resRep2);
    
    assert(
      "2nd greeting uses fast path",
      latestTrace && latestTrace.llmCalls === 0 && latestTrace.executionPath === "Smalltalk/Fastpath",
      `Expected fast path and 0 LLM calls. Got path: ${latestTrace?.executionPath}, LLM calls: ${latestTrace?.llmCalls}`
    );

    // Accumulate 2nd greeting into history
    history.push({ role: "user", content: "hi" });
    history.push({ role: "bot", content: parsedRep2.answer });

    // Send a 3rd greeting (should trigger repeats >= 3)
    console.log("Sending 3rd greeting (should trigger warm reply)...");
    latestTrace = null;
    const resRep3 = await runChatPipeline(mockSessionWithName, {
      message: "hi",
      sessionId: testSessionId,
      history: history
    });
    const parsedRep3 = await parseResponse(resRep3);

    // Warm reply triggers either Gemini streaming (llmCalls > 0) or fallback reply
    const isWarmLlm = latestTrace && latestTrace.llmCalls > 0;
    const isFallback = parsedRep3.answer.includes("Hi! What would you like to check") || 
                       parsedRep3.answer.includes("Hi! How can I help you");
    
    assert(
      "3rd greeting triggers repeats warm reply or fallback",
      isWarmLlm || isFallback,
      `Expected LLM call or fallback warm pool response. Got LLM calls: ${latestTrace?.llmCalls}, Answer: "${parsedRep3.answer}"`
    );

    // Accumulate 3rd greeting into history
    history.push({ role: "user", content: "hi" });
    history.push({ role: "bot", content: parsedRep3.answer });

    // ----------------------------------------------------
    // 4. Test Non-Regex Small Talk (Gemini Routing)
    // ----------------------------------------------------
    console.log("\n--- Category 4: Non-Regex Small Talk (Gemini Routing) ---");
    const nonRegexMsgs = [
      "tell me a funny joke",
      "do you like coding in typescript?"
    ];

    for (const msg of nonRegexMsgs) {
      latestTrace = null;
      const resNonRegex = await runChatPipeline(mockSessionWithName, {
        message: msg,
        sessionId: testSessionId,
        history: history
      });
      const parsedNonRegex = await parseResponse(resNonRegex);

      assert(
        `Non-regex small talk "${msg}" routes to smalltalk intent`,
        latestTrace && latestTrace.intentRoute?.kind === "smalltalk" && latestTrace.llmCalls > 0,
        `Expected intent kind "smalltalk" with LLM calls > 0. Got intent: ${latestTrace?.intentRoute?.kind}, LLM calls: ${latestTrace?.llmCalls}`
      );
      assert(
        `Non-regex small talk response content check`,
        parsedNonRegex.answer.length > 5,
        `Expected non-empty response. Got: "${parsedNonRegex.answer}"`
      );

      // Accumulate
      history.push({ role: "user", content: msg });
      history.push({ role: "bot", content: parsedNonRegex.answer });
    }

    // ----------------------------------------------------
    // 5. Test Database Persistence
    // ----------------------------------------------------
    console.log("\n--- Category 5: Database Persistence ---");
    // Retrieve saved messages for this session
    const messages = await query<{ role: string; content: string }>(
      "SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
      [testSessionId]
    );

    console.log(`Saved messages count: ${messages.length}`);
    assert(
      "User & bot messages persisted in database",
      messages.length >= 10,
      `Expected at least 10 messages persisted. Got: ${messages.length}`
    );

    const lastMessage = messages[messages.length - 1];
    assert(
      "Last message role is bot",
      lastMessage.role === "bot",
      `Expected last message role to be "bot". Got: "${lastMessage.role}"`
    );

  } finally {
    // Restore console.log
    console.log = originalLog;

    // ----------------------------------------------------
    // 6. Database Cleanup
    // ----------------------------------------------------
    if (testSessionId) {
      console.log("\n--- Database Cleanup ---");
      const deletedMsgs = await query("DELETE FROM chat_messages WHERE session_id = $1", [testSessionId]);
      const deletedSession = await query("DELETE FROM chat_sessions WHERE id = $1", [testSessionId]);
      console.log("Cleanup completed. Temporary test session and messages deleted.");
    }
  }

  // Final summary
  console.log("\n=== TEST RUN SUMMARY ===");
  const failed = results.filter(r => !r.ok);
  console.log(`Total assertions: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log("\nFailed Tests:");
    failed.forEach(f => console.error(`  - ${f.test}: ${f.message}`));
    process.exit(1);
  } else {
    console.log("\nAll E2E small talk checks passed successfully! 🎉");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
