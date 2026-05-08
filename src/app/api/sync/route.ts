import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { syncNotionToPostgres } from "@/lib/notion-sync";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncNotionToPostgres();

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
