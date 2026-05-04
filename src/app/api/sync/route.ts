import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { syncBedrockKnowledgeBase } from "@/lib/aws";
import { authOptions } from "@/lib/auth";

export async function POST() {
    try {
        const session = await getServerSession(authOptions);
        if (!session) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const ingestionJob = await syncBedrockKnowledgeBase();

        return NextResponse.json({
            message: "Sync started successfully",
            jobId: ingestionJob?.ingestionJobId,
            status: ingestionJob?.status,
        });
    } catch (error) {
        console.error("Sync API Error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to trigger sync" },
            { status: 500 }
        );
    }
}
