import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { query } from "@/lib/postgres";
import { syncNotionToPostgres } from "@/lib/notion-sync";

type LastSyncRow = {
  last_synced_at: string | null;
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
