import { NextResponse } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth/session";
import { createOrReshareChatLink } from "@/lib/chat/share/share-link";
import { revokeChatShareLink } from "@/lib/chat/share/share-revoke";
import { getChatShareStatus } from "@/lib/chat/share/share-status";
import { getOrCreateUser } from "@/lib/chat/store";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "Chat not found") {
    return noStore(NextResponse.json({ error: "Chat not found" }, { status: 404 }));
  }

  if (error instanceof Error && error.message === "Cannot share a chat with no messages") {
    return noStore(NextResponse.json({ error: error.message }, { status: 400 }));
  }

  return noStore(NextResponse.json({ error: "Internal server error" }, { status: 500 }));
}

async function getUserId() {
  const session = await requireSession();
  if (isSessionResponse(session)) return { response: noStore(session) };

  const user = await getOrCreateUser(session);
  return { userId: user.id };
}

function validSessionIdResponse(sessionId: string) {
  if (!UUID_PATTERN.test(sessionId)) {
    return noStore(NextResponse.json({ error: "Chat not found" }, { status: 404 }));
  }
  return null;
}

export async function GET(_req: Request, context: RouteContext) {
  try {
    const auth = await getUserId();
    if ("response" in auth) return auth.response;

    const { sessionId } = await context.params;
    const invalidSessionId = validSessionIdResponse(sessionId);
    if (invalidSessionId) return invalidSessionId;

    const result = await getChatShareStatus(sessionId, auth.userId);
    return noStore(NextResponse.json(result));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const auth = await getUserId();
    if ("response" in auth) return auth.response;

    const bodyText = await req.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return noStore(NextResponse.json({ error: "Invalid request body" }, { status: 400 }));
    }
    const reshare = typeof body?.reshare === "boolean" ? body.reshare : false;

    const { sessionId } = await context.params;
    const invalidSessionId = validSessionIdResponse(sessionId);
    if (invalidSessionId) return invalidSessionId;

    const result = await createOrReshareChatLink(sessionId, auth.userId, reshare);
    return noStore(NextResponse.json(result));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_req: Request, context: RouteContext) {
  try {
    const auth = await getUserId();
    if ("response" in auth) return auth.response;

    const { sessionId } = await context.params;
    const invalidSessionId = validSessionIdResponse(sessionId);
    if (invalidSessionId) return invalidSessionId;

    const result = await revokeChatShareLink(sessionId, auth.userId);
    return noStore(NextResponse.json(result));
  } catch (error) {
    return errorResponse(error);
  }
}
