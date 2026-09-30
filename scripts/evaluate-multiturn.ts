/**
 * scripts/evaluate-multiturn.ts
 *
 * Multi-Turn Conversation & Session State Benchmark
 * Evaluates session state transitions (activeProject, activePerson), pronoun resolution ("it", "he", "she"),
 * follow-up query contextualization, and user corrections across multi-turn chat sessions.
 *
 * Usage: npx tsx scripts/evaluate-multiturn.ts
 */

import "../src/lib/dns-hook";
import "dotenv/config";
import { lazyResolveSqlEntities, isFollowUpNeedingContext } from "../src/lib/query/entity-resolver";
import { resolveQuery } from "../src/lib/query/resolve-query";
import type { ChatHistoryItem } from "../src/lib/ai/openai";

interface SequenceTurn {
  turnNumber: number;
  userQuery: string;
  expectedActiveProject?: string;
  expectedActivePerson?: string;
  expectedDocTitleResolved?: string;
  expectedPersonNameResolved?: string;
  description: string;
}

interface MultiTurnSequence {
  sequenceId: string;
  description: string;
  turns: SequenceTurn[];
}

const BENCHMARK_SEQUENCES: MultiTurnSequence[] = [
  {
    sequenceId: "seq_01_project_pronoun_and_correction",
    description: "Project pronoun resolution & user correction switch",
    turns: [
      {
        turnNumber: 1,
        userQuery: "Tell me about Employee Onboarding.",
        expectedActiveProject: "Employee Onboarding",
        description: "Turn 1: Initial project mention",
      },
      {
        turnNumber: 2,
        userQuery: "Who works on it?",
        expectedActiveProject: "Employee Onboarding",
        expectedDocTitleResolved: "Employee Onboarding",
        description: "Turn 2: 'it' resolves to active project",
      },
      {
        turnNumber: 3,
        userQuery: "When was it updated?",
        expectedActiveProject: "Employee Onboarding",
        expectedDocTitleResolved: "Employee Onboarding",
        description: "Turn 3: 'it' retention on active project",
      },
      {
        turnNumber: 4,
        userQuery: "No, I meant the Recruitment project.",
        expectedActiveProject: "Recruitment",
        expectedDocTitleResolved: "Recruitment",
        description: "Turn 4: Correction updates active project to Recruitment",
      },
    ],
  },
  {
    sequenceId: "seq_02_person_pronoun_resolution",
    description: "Person pronoun resolution (Rahul -> he -> his tasks)",
    turns: [
      {
        turnNumber: 1,
        userQuery: "What did Rahul work on?",
        expectedActivePerson: "Rahul",
        description: "Turn 1: Person activity query",
      },
      {
        turnNumber: 2,
        userQuery: "Show recent activity for him",
        expectedActivePerson: "Rahul",
        expectedPersonNameResolved: "Rahul",
        description: "Turn 2: 'him' resolves to Rahul",
      },
      {
        turnNumber: 3,
        userQuery: "What are his open tasks?",
        expectedActivePerson: "Rahul",
        expectedPersonNameResolved: "Rahul",
        description: "Turn 3: 'his' resolves to Rahul",
      },
    ],
  },
];

async function runMultiTurnEvaluation() {
  console.log("⚡ Running Multi-Turn Conversation Benchmark...\n");

  let totalTurns = 0;
  let passedTurns = 0;

  for (const seq of BENCHMARK_SEQUENCES) {
    console.log(`\n======================================================`);
    console.log(`📌 Sequence: ${seq.sequenceId} (${seq.description})`);
    console.log(`======================================================`);

    let activeProject: string | undefined;
    let activePerson: string | undefined;
    const history: ChatHistoryItem[] = [];

    for (const turn of seq.turns) {
      totalTurns++;
      const t0 = performance.now();

      // 1. Initial intent parse
      const initialParsed = await resolveQuery(turn.userQuery);

      // 2. Entity & pronoun resolution with active state
      const resolved = await lazyResolveSqlEntities(
        initialParsed,
        history,
        undefined, // sessionName
        { lastPerson: activePerson, lastProject: activeProject }
      );

      const duration = performance.now() - t0;

      // Update active session state
      if (resolved.docTitle) activeProject = resolved.docTitle;
      if (resolved.personName) activePerson = resolved.personName;

      // Also check explicit correction match in query if present
      const correctionMatch = turn.userQuery.match(/No,\s+I\s+meant\s+(?:the\s+)?(.+?)(?:\s+project|\.|$)/i);
      if (correctionMatch?.[1]) {
        activeProject = correctionMatch[1].trim();
      }

      // Record in history for next turns
      history.push({ role: "user", content: turn.userQuery });
      history.push({ role: "bot", content: `Mock response for turn ${turn.turnNumber}` });

      // Verify assertions
      let pass = true;

      if (turn.expectedActiveProject && activeProject !== turn.expectedActiveProject) {
        pass = false;
      }
      if (turn.expectedActivePerson && activePerson !== turn.expectedActivePerson) {
        pass = false;
      }
      if (turn.expectedDocTitleResolved && resolved.docTitle !== turn.expectedDocTitleResolved) {
        pass = false;
      }
      if (turn.expectedPersonNameResolved && resolved.personName !== turn.expectedPersonNameResolved) {
        pass = false;
      }

      if (pass) passedTurns++;

      console.table([
        {
          Turn: turn.turnNumber,
          "User Query": turn.userQuery,
          "Active Project": activeProject || "(none)",
          "Active Person": activePerson || "(none)",
          "Resolved Doc": resolved.docTitle || "(none)",
          "Resolved Person": resolved.personName || "(none)",
          Latency: `${duration.toFixed(1)}ms`,
          Status: pass ? "✓ PASS" : "❌ FAIL",
        },
      ]);
    }
  }

  const accuracyPct = ((passedTurns / totalTurns) * 100).toFixed(1);
  console.log("\n==========================================================");
  console.log("📊 MULTI-TURN BENCHMARK SUMMARY");
  console.log(`   Total Turns Evaluated:  ${totalTurns}`);
  console.log(`   State Resolution Pass: ${accuracyPct}% (${passedTurns}/${totalTurns})`);
  console.log("==========================================================\n");
}

runMultiTurnEvaluation().catch((err) => {
  console.error("❌ Multi-turn evaluation failed:", err);
  process.exit(1);
});
