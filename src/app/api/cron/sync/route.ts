import { NextRequest, NextResponse } from "next/server";
import { syncNotionToPostgres, isSyncInProgress } from "@/lib/ingestion/sync";

export async function GET(req: NextRequest) {
  return handleCronTrigger(req);
}

export async function POST(req: NextRequest) {
  return handleCronTrigger(req);
}

async function handleCronTrigger(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.get("authorization");
      const urlSecret = req.nextUrl.searchParams.get("secret");
      const bearerToken = authHeader?.replace(/^Bearer\s+/i, "");

      if (bearerToken !== cronSecret && urlSecret !== cronSecret) {
        return NextResponse.json({ error: "Unauthorized: Invalid cron secret" }, { status: 401 });
      }
    }

    if (isSyncInProgress()) {
      return NextResponse.json(
        { message: "Sync already in progress", status: "running" },
        { status: 200 },
      );
    }

    const force = req.nextUrl.searchParams.get("force") === "true";
    const refreshContent = req.nextUrl.searchParams.get("refreshContent") === "true";
    const embed = req.nextUrl.searchParams.get("embed") !== "false" && process.env.EMBEDDINGS_ENABLED !== "false";

    const result = await syncNotionToPostgres({ force, embed, refreshContent });

    return NextResponse.json({
      message: "Background cron sync completed successfully",
      ...result,
    });
  } catch (error) {
    console.error("[api/cron/sync] Error triggering sync:", error);
    const message = error instanceof Error ? error.message : String(error);

    if (message === "Sync already in progress") {
      return NextResponse.json(
        { message: "Sync already in progress", status: "running" },
        { status: 200 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
