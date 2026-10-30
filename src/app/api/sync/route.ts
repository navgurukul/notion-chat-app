import { NextResponse, NextRequest } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth/session";
import { getNotionLastSyncRun, query } from "@/lib/db";
import { syncNotionToPostgres } from "@/lib/ingestion/sync";
import { createRateLimiter } from "@/lib/shared/rate-limit";
import { hasKnowledgeBaseAccess, KNOWLEDGE_BASE_MANAGER_EMAILS} from "@/lib/shared/access";

type LastSyncRow = {
  last_synced_at: string | null;
};

const checkSyncRateLimit = createRateLimiter({
  maxRequests: 1,
  windowMs: 2 * 60_000,
});

function denySyncAccess() {
  return NextResponse.json(
    {
      error: `Forbidden: only ${Array.from(KNOWLEDGE_BASE_MANAGER_EMAILS).join(", ")} can sync or rebuild the knowledge base.`,
    },
    { status: 403 },
  );
}

export async function GET() {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

    const lastRun = await getNotionLastSyncRun();
    if (lastRun) {
      return NextResponse.json({ synced_at: lastRun });
    }

    const rows = await query<LastSyncRow>(
      "SELECT MAX(synced_at)::text AS last_synced_at FROM notion_pages",
    );

    return NextResponse.json({
      synced_at: rows[0]?.last_synced_at ?? null,
    });
  } catch (error) {
    console.error("Sync status API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read sync status" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

    if (!hasKnowledgeBaseAccess(session)) {
      return denySyncAccess();
    }

    const userKey = session.user?.email?.toLowerCase() || "anonymous";
    if (!checkSyncRateLimit(userKey)) {
      return NextResponse.json(
        { error: "Too many sync requests. Wait a couple of minutes before trying again." },
        { status: 429 },
      );
    }

    const { searchParams } = new URL(req.url);
    const force = searchParams.get("force") === "true";
    const embed =
      searchParams.get("embed") === "true" &&
      process.env.EMBEDDINGS_ENABLED !== "false";
    const refreshContent = searchParams.get("refreshContent") === "true";

    const result = await syncNotionToPostgres({ force, embed, refreshContent });

    return NextResponse.json({
      message: "Sync complete",
      ...result,
    });
  } catch (error) {
    console.error("Sync API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to trigger sync" },
      { status: 500 },
    );
  }
}
