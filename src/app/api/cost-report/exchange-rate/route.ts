import { NextResponse } from "next/server";

// Public, no-key exchange rate API. Rates don't need to be second-by-second
// fresh for a cost estimate, so we cache in-memory for a few hours and fall
// back to a last-known-good value if the upstream is ever unreachable.
const UPSTREAM_URL = "https://open.er-api.com/v6/latest/USD";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FALLBACK_USD_TO_INR = 95.4; // used only if we've never had a successful fetch

let cached: { rate: number; fetchedAt: number } | null = null;

export async function GET() {
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      usdToInr: cached.rate,
      fetchedAt: cached.fetchedAt,
      source: "cache",
    });
  }

  try {
    const res = await fetch(UPSTREAM_URL, {
      // Next.js data cache as a second layer, in case the process restarts.
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.INR;
    if (!Number.isFinite(rate)) throw new Error("INR rate missing from response");

    cached = { rate: rate as number, fetchedAt: now };
    return NextResponse.json({ usdToInr: rate, fetchedAt: now, source: "live" });
  } catch (error) {
    console.error("Exchange rate fetch failed, using fallback:", error);
    // Prefer a stale cached rate over the hardcoded fallback if we have one.
    return NextResponse.json({
      usdToInr: cached?.rate ?? FALLBACK_USD_TO_INR,
      fetchedAt: cached?.fetchedAt ?? now,
      source: cached ? "stale-cache" : "fallback",
    });
  }
}