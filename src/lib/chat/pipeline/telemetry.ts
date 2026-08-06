import { PipelineTrace, LATENCY_BUDGETS } from "./timing";

export class PipelineTelemetry {
  private trace: PipelineTrace;
  private startTime: number;
  private stepStartTimes: Record<string, number> = {};

  constructor(requestId: string, sessionId: string | null, originalQuery: string) {
    this.startTime = performance.now();
    this.trace = {
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
      originalQuery,
      llmCalls: 0,
      durations: {}
    };
  }

  startStep(name: string) {
    this.stepStartTimes[name] = performance.now();
  }

  endStep(name: string) {
    const start = this.stepStartTimes[name];
    if (start) {
      const elapsed = Math.round(performance.now() - start);
      this.trace.durations[name as keyof typeof this.trace.durations] = elapsed;
    }
  }

  setIntent(kind: string, confidence: number, source: string) {
    this.trace.intentRoute = { kind, confidence, source };
  }

  setExecutionPath(path: PipelineTrace["executionPath"]) {
    this.trace.executionPath = path;
  }

  setPronounResolvedQuery(query: string) {
    this.trace.pronounResolvedQuery = query;
  }

  setReformulatedQuery(query: string) {
    this.trace.reformulatedQuery = query;
  }

  logEntity(
    type: "person" | "page",
    value: string,
    quality: string,
    confidence?: number,
    ambiguous?: boolean,
    candidates?: string[],
    url?: string | null
  ) {
    if (!this.trace.entities) {
      this.trace.entities = {};
    }
    if (type === "person") {
      this.trace.entities.person = { value, quality, confidence, ambiguous, candidates };
    } else if (type === "page") {
      this.trace.entities.page = { value, quality, url };
    }
  }

  logRetrieval(vector: number, fts: number, merged: number, mmr: number, final: number) {
    (this.trace as any).retrievalDiagnostics = {
      vector,
      fts,
      merged,
      mmr,
      final
    };
  }

  incrementLlmCalls() {
    this.trace.llmCalls++;
  }

  getTrace(): PipelineTrace {
    return this.trace;
  }

  finish() {
    const now = performance.now();
    this.trace.durations.total_ms = Math.round(now - this.startTime);

    // Flag budget violations
    const budgetWarnings: string[] = [];
    for (const [stage, budget] of Object.entries(LATENCY_BUDGETS)) {
      const elapsed = this.trace.durations[stage as keyof typeof this.trace.durations];
      if (elapsed !== undefined && elapsed > budget) {
        budgetWarnings.push(`${stage} exceeded budget (${elapsed}ms > ${budget}ms)`);
      }
    }

    const logPayload = {
      ...this.trace,
      budgetWarnings: budgetWarnings.length ? budgetWarnings : undefined
    };

    // Structured JSON Log
    console.log("[pipeline-telemetry]", JSON.stringify(logPayload));

    // Pretty-print in development
    if (process.env.NODE_ENV !== "production") {
      console.log("\n================ PIPELINE TRACE ================");
      console.log(`Request ID: ${this.trace.requestId}`);
      console.log(`Query: ${this.trace.originalQuery}`);
      console.log(`Intent: ${this.trace.intentRoute?.kind} (conf: ${this.trace.intentRoute?.confidence}, src: ${this.trace.intentRoute?.source})`);
      console.log(`Execution Path: ${this.trace.executionPath}`);
      console.log(`LLM Calls: ${(this.trace as any).llmCalls || 0}`);
      console.log("Durations (ms):", this.trace.durations);
      if ((this.trace as any).retrievalDiagnostics) {
        console.log("Retrieval Diagnostics:", (this.trace as any).retrievalDiagnostics);
      }
      if (budgetWarnings.length) {
        console.warn("⚠️ Latency Warnings:", budgetWarnings);
      }
      console.log("================================================\n");
    }
  }
}
