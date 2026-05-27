export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** Gemini quota/rate-limit related errors (typically HTTP 429). */
export function isGeminiQuotaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;

  return (
    status === 429 ||
    /quota exceeded|insufficient_quota|rate limit|rate_limit|too many requests|free_tier_requests/i.test(
      message,
    )
  );
}

export const GEMINI_QUOTA_USER_MESSAGE =
  "The AI provider quota/rate limit was reached for your API key. This can happen even if billing is enabled (limits are per key/model/project). Wait about a minute and try again, or check Google AI Studio for Billing/Quotas and ensure the correct model has available quota. If needed, switch `AI_PROVIDER` in your server `.env`.";
