import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { authOptions } from "@/lib/auth";
import { areDebugRoutesEnabled, getErrorMessage, maskIdentifier } from "@/lib/debug";

export async function GET(req: NextRequest) {
    if (!areDebugRoutesEnabled()) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const kbId = process.env.AWS_KNOWLEDGE_BASE_ID;
    const query = req.nextUrl.searchParams.get("query") || "What is NavGurukul?";
    const includeContent =
        process.env.NODE_ENV !== "production" &&
        req.nextUrl.searchParams.get("includeContent") === "true";

    if (!kbId) {
        return NextResponse.json({ error: "AWS_KNOWLEDGE_BASE_ID is missing" }, { status: 500 });
    }

    const client = new BedrockAgentRuntimeClient({
        region: process.env.AWS_REGION || "us-east-1",
    });

    try {
        const command = new RetrieveCommand({
            knowledgeBaseId: kbId,
            retrievalQuery: {
                text: query,
            },
        });

        const response = await client.send(command);

        return NextResponse.json({
            kbId: maskIdentifier(kbId),
            query,
            resultsCount: response.retrievalResults?.length || 0,
            results: response.retrievalResults?.map(r => ({
                score: r.score,
                textLength: r.content?.text?.length || 0,
                source: r.location?.s3Location?.uri,
                preview: includeContent ? r.content?.text?.substring(0, 500) : undefined,
            }))
        });
    } catch (error) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
