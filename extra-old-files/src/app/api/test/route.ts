import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { areDebugRoutesEnabled, envPresence } from "@/lib/debug";

export async function GET() {
	if (!areDebugRoutesEnabled()) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const session = await getServerSession(authOptions);
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	return NextResponse.json({
		timestamp: new Date().toISOString(),
		nodeEnv: process.env.NODE_ENV,
		requiredEnv: envPresence(),
	});
}
