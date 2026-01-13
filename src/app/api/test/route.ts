import { NextResponse } from "next/server";

// Debug route to check which environment variables are available at runtime.
// WARNING: This route logs full environment variable values to server logs (CloudWatch).
// Do NOT expose this route publicly in production. It returns a masked JSON summary.
// Call: GET /api/test
export async function GET() {
	const keys = Object.keys(process.env);

	const summary: Record<string, { present: boolean; value: string | null }> = {};

	for (const key of keys) {
		const val = process.env[key] ?? null;
		// Log full value to server logs (CloudWatch)
		console.log(`ENV DEBUG: ${key} = ${val}`);

		// Only reveal NEXT_PUBLIC_ values in the response; mask others
		const display = key.startsWith("NEXT_PUBLIC_") ? val : val ? "***masked***" : null;

		summary[key] = { present: !!val, value: display };
	}

	console.log(`ENV DEBUG: total env keys = ${keys.length}`);

	return NextResponse.json({
		timestamp: new Date().toISOString(),
		totalKeys: keys.length,
		summary,
	});
}

