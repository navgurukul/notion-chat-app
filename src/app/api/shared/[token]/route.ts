import { NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth/session";
import { hasNavgurukulDomainAccess } from "@/lib/shared/navgurukul-domain";
import { getSharedChatByToken } from "@/lib/chat/share-read";

type RouteContext = {
  params: Promise<{ token: string }>;
};

function response(body: unknown, status = 200) {
  const result = NextResponse.json(body, { status });
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Robots-Tag", "noindex");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}

function notFound() {
  return response({ error: "Not found" }, 404);
}

export async function GET(_req: Request, context: RouteContext) {
  try {
    const session = await requireSession();
    if (isSessionResponse(session) || !hasNavgurukulDomainAccess(session)) return notFound();

    const { token } = await context.params;
    if (token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return notFound();

    const sharedChat = await getSharedChatByToken(token);
    if (!sharedChat) return notFound();
    return response(sharedChat);
  } catch {
    return response({ error: "Internal server error" }, 500);
  }
}
