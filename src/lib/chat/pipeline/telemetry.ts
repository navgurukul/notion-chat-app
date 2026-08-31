import type { ChatHistoryItem } from "@/lib/ai/openai";
import type { ParsedQuery } from "@/lib/query/types";
import type { ChunkRetrievalHit, RetrievalConfidenceResult } from "@/lib/rag";

// ---------------------------------------------------------------------------
// Types & latency budgets (formerly pipeline/timing.ts)
// ---------------------------------------------------------------------------

export type ResolvedEntityTrace = {
  value: any;
  quality: string;
  ambiguous?: boolean;
  candidates?: string[];
  url?: string | null;
  confidence?: number;
};

export type PipelineTrace = {
  requestId: string;
  sessionId: string | null;
  timestamp: string;
  originalQuery: string;
  pronounResolvedQuery?: string;
  reformulatedQuery?: string;
  intentRoute?: {
    kind: string;
    confidence: number;
    source: string;
  };
  entities?: {
    person?: ResolvedEntityTrace;
    page?: ResolvedEntityTrace;
    comparePageB?: ResolvedEntityTrace;
    year?: ResolvedEntityTrace;
    dateRange?: ResolvedEntityTrace;
  };
  executionPath?: "SQL Hit" | "RAG Fallback" | "Notion Link" | "Smalltalk/Fastpath";
  llmCalls: number;
  durations: {
    entity_resolve_ms?: number;
    intent_classifier_ms?: number;
    sql_ms?: number;
    rag_ms?: number;
    reformulation_ms?: number;
    total_ms?: number;
  };
  ragHits?: Array<{
    title: string;
    score: number;
    passedConstraints?: boolean;
  }>;
};

export type PipelineContext = {
  message: string;
  history: ChatHistoryItem[];
  sessionId: string | null;
  reformulatedQuery?: string;
  lastProject?: string;
  lastPerson?: string;
  lastMale?: string;
  lastFemale?: string;
  sessionName?: string;
  trace?: PipelineTrace;
  telemetry?: any;
  isWrongAnswerRetry?: boolean;
};

export type PipelineTimings = {
  normalization: number;
  intentClassification: number;
  sqlAnswerAttempt: number;
  queryReformulation: number;
  queryExpansion: number;
  retrieval: number;
  expandedQueryCount: number;
  contextChars: number;
  topScore: number;
  avgScore: number;
  confidenceOk: boolean;
  historyEntityUsed: boolean;
};

export function createEmptyTimings(): PipelineTimings {
  return {
    normalization: 0,
    intentClassification: 0,
    sqlAnswerAttempt: 0,
    queryReformulation: 0,
    queryExpansion: 0,
    retrieval: 0,
    expandedQueryCount: 0,
    contextChars: 0,
    topScore: 0,
    avgScore: 0,
    confidenceOk: true,
    historyEntityUsed: false,
  };
}

// Latency Budgets (in milliseconds)
export const LATENCY_BUDGETS = {
  entity_resolve_ms: 50,
  intent_classifier_ms: 150,
  sql_ms: 25,
  rag_ms: 150,
  reformulation_ms: 100,
  total_ms: 2800,
};

// ---------------------------------------------------------------------------
// Route & retrieval diagnostics logging (formerly retrieval-diagnostics.ts)
// ---------------------------------------------------------------------------

export type RouteDecision =
  | "sql_hit"
  | "sql_miss_metadata"
  | "sql_weak_rag"
  | "semantic_rag"
  | "link"
  | "sql_synthesis_stream";

export function logChatRoute(decision: RouteDecision, parsed: ParsedQuery, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production" && process.env.CHAT_DEBUG !== "true") return;

  console.log("[chat] route", {
    decision,
    kind: parsed.kind,
    confidence: parsed.confidence,
    source: parsed.source,
    personName: parsed.personName,
    docTitle: parsed.docTitle,
    ...extra,
  });
}

export function logRetrievalDiagnostics(
  parsed: ParsedQuery,
  searchQueries: string[],
  confidence: RetrievalConfidenceResult,
  hits: ChunkRetrievalHit[],
) {
  if (process.env.NODE_ENV === "production" && process.env.CHAT_DEBUG !== "true") return;

  console.log("[chat] retrieval", {
    kind: parsed.kind,
    search_queries: searchQueries,
    confidence_ok: confidence.ok,
    confidence_reason: confidence.reason,
    top_score: Number(confidence.topScore.toFixed(4)),
    avg_score: Number(confidence.avgScore.toFixed(4)),
    chunk_count: confidence.chunkCount,
    prefetch_chars: confidence.prefetchChars,
    top_chunks: hits.slice(0, 5).map((hit) => ({
      title: hit.title,
      final: Number(hit.final_score.toFixed(4)),
      sem: Number(hit.sem_score.toFixed(4)),
      kw: Number(hit.kw_score.toFixed(4)),
    })),
  });
}

// ---------------------------------------------------------------------------
// PipelineTelemetry class
// ---------------------------------------------------------------------------

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