import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";

export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};

export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    // If user is not authenticated, redirect to login page.
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const email = token.email as string | undefined;
  const ok = hasNavgurukulDomainAccess({ user: { email } });
  if (!ok) {
    return NextResponse.json(
      { error: "Forbidden: only @navgurukul.org users can access this app." },
      { status: 403 },
    );
  }

  return NextResponse.next();
}
