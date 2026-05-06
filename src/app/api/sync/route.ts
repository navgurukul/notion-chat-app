import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { syncNotionToPostgres } from "@/lib/notion-sync";
import { authOptions } from "@/lib/auth";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncNotionToPostgres();

    return NextResponse.json({
      message: "Sync completed successfully",
      total: result.total,
      synced: result.synced,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error("Sync API Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync" },
      { status: 500 },
    );
  }
}
