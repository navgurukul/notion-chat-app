import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth/options";

export async function requireSession(): Promise<Session | NextResponse> {
  if (process.env.NEXT_PUBLIC_MOCK_SESSION === "true") {
    return {
      user: {
        name: "Test User",
        email: "test.user@navgurukul.org",
        image: null
      },
      expires: "2026-12-31T23:59:59.999Z"
    };
  }
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}

export function isSessionResponse(value: Session | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}
