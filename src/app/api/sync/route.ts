import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { syncBedrockKnowledgeBase } from "@/lib/aws";

export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession();
        if (!session) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const ingestionJob = await syncBedrockKnowledgeBase();

        return NextResponse.json({
            message: "Sync started successfully",
            jobId: ingestionJob?.ingestionJobId,
            status: ingestionJob?.status,
        });
    } catch (error: any) {
        console.error("Sync API Error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to trigger sync" },
            { status: 500 }
        );
    }
}
