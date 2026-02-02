import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { retrieveNotionContext } from "@/lib/aws";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession();
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

    console.log("🔍 Debug Query:", query);

    const context = await retrieveNotionContext(query);

    return NextResponse.json({
      query,
      contextLength: context?.length || 0,
      context: context || "No context retrieved",
      chunks: context ? context.split("\n\n---\n\n") : [],
      chunkCount: context ? context.split("\n\n---\n\n").length : 0,
    });
  } catch (error: any) {
    console.error("Debug Context Error:", error);
    return NextResponse.json(
      { 
        error: error.message || "Failed to retrieve context",
        details: error.toString()
      },
      { status: 500 }
    );
  }
}
