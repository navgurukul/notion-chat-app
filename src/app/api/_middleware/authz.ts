import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/options";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";

export async function requireNavgurukulSession() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasNavgurukulDomainAccess(session.user ? { user: { email: session.user.email } } : undefined)) {
    return NextResponse.json(
      {
        error: "Forbidden: only @navgurukul.org users can access this app.",
      },
      { status: 403 },
    );
  }

  return session;
}

