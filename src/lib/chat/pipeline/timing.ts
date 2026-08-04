import type { ChatHistoryItem } from "@/lib/ai/openai";

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
