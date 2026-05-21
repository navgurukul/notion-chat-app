import { NextResponse, NextRequest } from "next/server";
import { isSessionResponse, requireSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { syncNotionToPostgres } from "@/lib/ingestion";

type LastSyncRow = {
  last_synced_at: string | null;
};

export async function GET() {
  try {
    const session = await requireSession();
    if (isSessionResponse(session)) return session;

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

    const { searchParams } = new URL(req.url);
    const force = searchParams.get("force") === "true";
    const embed = searchParams.get("embed") !== "false";
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
