import "dotenv/config";
import "../src/lib/dns-hook";
import { runChatPipeline } from "../src/lib/chat/pipeline";
import { createChatSession, getSessionState, getOrCreateUser } from "../src/lib/chat/store";
import { query } from "../src/lib/db/postgres";
import { resolveQuery } from "../src/lib/query/resolve-query";

// Timing budget thresholds in ms
const GREETING_MAX_MS = 150; 

async function main() {
  console.log("=== STARTING E2E DIALOGUE & OBSERVABILITY REGRESSION SUITE ===");

  const mockSession = {
    user: {
      name: "Test User",
      email: "test.user@navgurukul.org"
    },
    expires: new Date(Date.now() + 3600 * 1000).toISOString()
  };

  const user = await getOrCreateUser(mockSession);
  const chatSession = await createChatSession(user.id, "E2E Regression Test Session");
  const sessionId = chatSession.id;

  // Intercept console.log to capture the telemetry output JSON
  const originalLog = console.log;
  let telemetryTrace: any = null;

  console.log = function (...args: any[]) {
    // Check if the argument is a telemetry trace
    if (args[0] === "[pipeline-telemetry]" && typeof args[1] === "string") {
      try {
        telemetryTrace = JSON.parse(args[1]);
      } catch (e) {
        // Ignore parse errors
      }
    } else {
      // Fallback for single-argument logging or other formatted logs
      for (const arg of args) {
        if (typeof arg === "string" && arg.includes("[pipeline-telemetry]")) {
          try {
            const jsonStr = arg.replace("[pipeline-telemetry]", "").trim();
            telemetryTrace = JSON.parse(jsonStr);
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
    originalLog.apply(console, args);
  };

  try {
    // ----------------------------------------------------
    // TEST 1: Greeting Fast Path
    // ----------------------------------------------------
    console.log("\n--- TEST 1: Greeting Fast Path ('hi') ---");
    telemetryTrace = null;
    const t0 = performance.now();
    const res1 = await runChatPipeline(mockSession, {
      message: "hi",
      sessionId
    });
    const duration1 = performance.now() - t0;
    const body1 = await res1.json();

    console.log(`Duration: ${duration1.toFixed(2)}ms`);
    console.log(`Answer: "${body1.answer}"`);
    console.log(`Telemetry Trace:`, telemetryTrace);

    if (duration1 > GREETING_MAX_MS) {
      throw new Error(`Greeting took ${duration1.toFixed(2)}ms, exceeding performance budget of ${GREETING_MAX_MS}ms`);
    }
    if (!telemetryTrace) {
      throw new Error("Telemetry trace was not logged for Greeting query");
    }
    if (telemetryTrace.llmCalls !== 0) {
      throw new Error(`Expected 0 LLM calls for greeting, got ${telemetryTrace.llmCalls}`);
    }
    if (telemetryTrace.executionPath !== "Smalltalk/Fastpath" && telemetryTrace.executionPath !== "Fastpath") {
      throw new Error(`Expected executionPath to be 'Fastpath' or 'Smalltalk/Fastpath', got: '${telemetryTrace.executionPath}'`);
    }
    console.log("✅ TEST 1 PASSED: Greeting was answered in <150ms with 0 LLM calls and correct telemetry.");

    // ----------------------------------------------------
    // TEST 2: Ambiguous/Vague Smalltalk Check
    // ----------------------------------------------------
    console.log("\n--- TEST 2: Ambiguous Query Check ('Who owns it?') ---");
    telemetryTrace = null;
    
    // We expect the router to classify "Who owns it?" as smalltalk since there's no history/context.
    const parsedAmbiguous = await resolveQuery("Who owns it?", [], "Test User");
    console.log("Parsed query:", parsedAmbiguous);
    
    if (parsedAmbiguous.kind !== "smalltalk") {
      throw new Error(`Expected ambiguous query 'Who owns it?' to route to 'smalltalk', got: '${parsedAmbiguous.kind}'`);
    }
    console.log("✅ TEST 2 PASSED: Ambiguous query correctly routed to smalltalk.");

    // ----------------------------------------------------
    // TEST 3: Multi-turn Dialogue & Context Carryover
    // ----------------------------------------------------
    console.log("\n--- TEST 3: Multi-turn Person Task Query ('Is there any task for Amruta ji?') ---");
    telemetryTrace = null;
    const res3 = await runChatPipeline(mockSession, {
      message: "Is there any task for Amruta ji?",
      sessionId
    });
    const body3 = await res3.json();
    console.log(`Answer: "${body3.answer.substring(0, 100)}..."`);
    
    // Wait for async state saver
    await new Promise(resolve => setTimeout(resolve, 500));

    const state = await getSessionState(sessionId);
    console.log("Database Session State activePerson:", state?.activePerson);
    if (state?.activePerson?.name !== "Amruta") {
      throw new Error(`Expected activePerson to be 'Amruta', got: '${state?.activePerson?.name}'`);
    }

    console.log("\n--- Sending follow-up: 'What projects is she working on?' ---");
    telemetryTrace = null;
    const res4 = await runChatPipeline(mockSession, {
      message: "What projects is she working on?",
      sessionId
    });
    const body4 = await res4.json();
    console.log(`Answer: "${body4.answer.substring(0, 100)}..."`);
    console.log(`Telemetry Trace:`, telemetryTrace);

    if (!telemetryTrace) {
      throw new Error("Telemetry trace was not logged for follow-up query");
    }
    if (telemetryTrace.entities?.person?.value !== "Amruta") {
      throw new Error(`Expected resolved person to be 'Amruta' via pronoun carryover, got: '${telemetryTrace.entities?.person?.value}'`);
    }
    if (telemetryTrace.executionPath !== "SQL Hit") {
      throw new Error(`Expected executionPath to be 'SQL Hit', got: '${telemetryTrace.executionPath}'`);
    }
    console.log("✅ TEST 3 PASSED: Multi-turn dialogue carried context and resolved pronoun correctly.");

    // ----------------------------------------------------
    // TEST 4: Entity Override ("what about sanjana's task")
    // ----------------------------------------------------
    console.log("\n--- TEST 4: Entity Override ('what about sanjana's task') ---");
    await runChatPipeline(mockSession, {
      message: "What tasks is Tamanna assigned to?",
      sessionId
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    let stateBefore = await getSessionState(sessionId);
    console.log("Active person before:", stateBefore?.activePerson?.name);
    if (stateBefore?.activePerson?.name !== "Tamanna") {
      throw new Error(`Expected activePerson to be 'Tamanna', got: '${stateBefore?.activePerson?.name}'`);
    }

    const res4 = await runChatPipeline(mockSession, {
      message: "what about sanjana's task",
      sessionId
    });
    const body4 = await res4.json();
    console.log(`Answer: "${body4.answer.substring(0, 100)}..."`);
    await new Promise(resolve => setTimeout(resolve, 500));
    let stateAfter = await getSessionState(sessionId);
    console.log("Active person after:", stateAfter?.activePerson?.name);
    if (stateAfter?.activePerson?.name !== "Sanjana") {
      throw new Error(`Expected activePerson to be 'Sanjana' after override, got: '${stateAfter?.activePerson?.name}'`);
    }
    console.log("✅ TEST 4 PASSED: Entity override successfully updated conversation context.");

    // ----------------------------------------------------
    // TEST 5: Boolean Project Membership ("Is Tamanna working on Oscar?")
    // ----------------------------------------------------
    console.log("\n--- TEST 5: Boolean Project Membership ---");
    const res5a = await runChatPipeline(mockSession, {
      message: "Is Tamanna working on Oscar?",
      sessionId
    });
    const body5a = await res5a.json();
    console.log(`Answer (Tamanna on Oscar): "${body5a.answer}"`);
    if (!body5a.answer.startsWith("No.")) {
      throw new Error(`Expected answer to start with 'No.', got: '${body5a.answer}'`);
    }

    const res5b = await runChatPipeline(mockSession, {
      message: "Is Souvik working on Oscar?",
      sessionId
    });
    const body5b = await res5b.json();
    console.log(`Answer (Souvik on Oscar): "${body5b.answer}"`);
    if (!body5b.answer.startsWith("Yes.")) {
      throw new Error(`Expected answer to start with 'Yes.', got: '${body5b.answer}'`);
    }
    console.log("✅ TEST 5 PASSED: Boolean project membership query correctly answered Yes/No.");

    // ----------------------------------------------------
    // TEST 6: Multi-entity Project Task Filtering
    // ----------------------------------------------------
    console.log("\n--- TEST 6: Multi-entity Project Task Filtering ('what task Komal is working on in Oscar project') ---");
    telemetryTrace = null;
    const res6 = await runChatPipeline(mockSession, {
      message: "what task Komal is working on in Oscar project",
      sessionId
    });
    const body6 = await res6.json();
    console.log(`Answer: "${body6.answer.substring(0, 100)}..."`);
    console.log(`Telemetry Trace:`, telemetryTrace);

    if (!telemetryTrace) {
      throw new Error("Telemetry trace was not logged for multi-entity query");
    }
    if (telemetryTrace.entities?.person?.value !== "Komal") {
      throw new Error(`Expected resolved person to be 'Komal', got: '${telemetryTrace.entities?.person?.value}'`);
    }
    if (telemetryTrace.entities?.page?.value !== "Oscar") {
      throw new Error(`Expected resolved project to be 'Oscar', got: '${telemetryTrace.entities?.page?.value}'`);
    }
    console.log("✅ TEST 6 PASSED: Multi-entity project task filtering successfully combined person and project constraints.");

    // ----------------------------------------------------
    // TEST 7: Team Roster Count ("How many developers are working on Oscar?")
    // ----------------------------------------------------
    console.log("\n--- TEST 7: Team Roster Count ('How many developers are working on Oscar?') ---");
    const res7 = await runChatPipeline(mockSession, {
      message: "How many developers are working on Oscar?",
      sessionId
    });
    const body7 = await res7.json();
    console.log(`Answer: "${body7.answer}"`);
    if (!body7.answer.startsWith("There are ")) {
      throw new Error(`Expected answer to start with 'There are ', got: '${body7.answer}'`);
    }
    console.log("✅ TEST 7 PASSED: Team roster count query returned direct count summary.");

    console.log("\n=== E2E REGRESSION SUITE COMPLETED SUCCESSFULLY ===");
  } finally {
    // Restore console.log
    console.log = originalLog;

    // Clean up DB
    await query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
    await query("DELETE FROM chat_sessions WHERE id = $1", [sessionId]);
    console.log("Cleaned up database test session.");
  }
}

main().catch(err => {
  console.error("❌ E2E REGRESSION SUITE FAILED:", err);
  process.exit(1);
});
