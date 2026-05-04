import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { retrieveNotionContextWithMetadata } from "@/lib/aws";
import { authOptions } from "@/lib/auth";
import { areDebugRoutesEnabled, getErrorDetails, getErrorMessage } from "@/lib/debug";

export async function POST(req: NextRequest) {
  try {
    if (!areDebugRoutesEnabled()) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { query } = await req.json();
    if (!query) {
      return NextResponse.json(
        { error: "Query is required" },
        { status: 400 }
      );
    }

    const retrieval = await retrieveNotionContextWithMetadata(query);
    const context = retrieval.context;
    const chunks = context ? context.split("\n\n---\n\n") : [];
    const includeContent =
      process.env.NODE_ENV !== "production" &&
      req.nextUrl.searchParams.get("includeContent") === "true";

    return NextResponse.json({
      query,
      mode: retrieval.mode,
      contextLength: context?.length || 0,
      chunkCount: chunks.length,
      sourceCount: retrieval.sourceCount,
      retrievalQueryCount: retrieval.retrievalQueryCount,
      chunks: chunks.map((chunk, index) => ({
        index,
        length: chunk.length,
        preview: includeContent ? chunk.substring(0, 500) : undefined,
      })),
    });
  } catch (error) {
    console.error("Debug Context Error:", error);
    return NextResponse.json(
      { 
        error: getErrorMessage(error) || "Failed to retrieve context",
        details: getErrorDetails(error)
      },
      { status: 500 }
    );
  }
}
