import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/options";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";

export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};

export async function middleware(req: NextRequest) {
  // Allow static assets and NextAuth endpoints via matcher negative lookahead.

  const session = await getServerSession(authOptions);
  if (!session) {
    // If user is not authenticated, redirect to login page.
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const ok = hasNavgurukulDomainAccess({ user: { email: session.user?.email } });
  if (!ok) {
    return NextResponse.json(
      { error: "Forbidden: only @navgurukul.org users can access this app." },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

