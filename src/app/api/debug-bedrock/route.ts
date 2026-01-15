import { NextRequest, NextResponse } from "next/server";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

export async function GET(req: NextRequest) {
    const kbId = process.env.AWS_KNOWLEDGE_BASE_ID;
    const query = req.nextUrl.searchParams.get("query") || "What is NavGurukul?";

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
            kbId,
            query,
            resultsCount: response.retrievalResults?.length || 0,
            results: response.retrievalResults?.map(r => ({
                text: r.content?.text?.substring(0, 500),
                score: (r as any).score
            }))
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
