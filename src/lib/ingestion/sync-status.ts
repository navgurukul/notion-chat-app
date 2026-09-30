export const EMBEDDING_STATUS = {
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
} as const;

export type EmbeddingStatus =
  (typeof EMBEDDING_STATUS)[keyof typeof EMBEDDING_STATUS];

const RETRY_STATUSES = new Set<EmbeddingStatus>([
  EMBEDDING_STATUS.pending,
  EMBEDDING_STATUS.processing,
  EMBEDDING_STATUS.failed,
]);

export function needsEmbeddingRetry(status: string | null | undefined) {
  if (!status) return true;
  return RETRY_STATUSES.has(status as EmbeddingStatus);
}

export function resolveEmbeddingStatus(embed: boolean, failed: boolean): EmbeddingStatus {
  if (!embed) return EMBEDDING_STATUS.pending;
  return failed ? EMBEDDING_STATUS.failed : EMBEDDING_STATUS.completed;
}