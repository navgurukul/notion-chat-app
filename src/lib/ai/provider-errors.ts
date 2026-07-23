export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** OpenAI quota/rate-limit related errors (typically HTTP 429). */
export function isOpenAIQuotaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;

  return (
    status === 429 ||
    /quota exceeded|insufficient_quota|rate limit|rate_limit|too many requests/i.test(
      message,
    )
  );
}

export const OPENAI_QUOTA_USER_MESSAGE =
  "The OpenAI rate limit or quota was reached for your API key. Wait about a minute and try again, or check your OpenAI dashboard for quota and usage limits.";

/** Backward compatibility aliases */
export const isGeminiQuotaError = isOpenAIQuotaError;
export const GEMINI_QUOTA_USER_MESSAGE = OPENAI_QUOTA_USER_MESSAGE;
