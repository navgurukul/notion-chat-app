const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

type RateLimitEntry = { count: number; resetAt: number };

export type RateLimitOptions = {
  maxRequests: number;
  windowMs: number;
};

export function createRateLimiter(options: RateLimitOptions) {
  const rateLimitMap = new Map<string, RateLimitEntry>();

  return function checkRateLimit(userKey: string) {
    const now = Date.now();
    const entry = rateLimitMap.get(userKey);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(userKey, { count: 1, resetAt: now + options.windowMs });
      return true;
    }

    if (entry.count >= options.maxRequests) return false;
    entry.count += 1;
    return true;
  };
}

const defaultRateLimiter = createRateLimiter({
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

export function checkRateLimit(userKey: string) {
  return defaultRateLimiter(userKey);
}
