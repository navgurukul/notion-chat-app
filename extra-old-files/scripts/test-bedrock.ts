import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import * as dotenv from "dotenv";
dotenv.config();

const client = new BedrockAgentRuntimeClient({
    region: process.env.AWS_REGION || "us-east-1",
});

async function testRetrieval() {
    const kbId = process.env.AWS_KNOWLEDGE_BASE_ID;
    if (!kbId) {
        console.error("❌ AWS_KNOWLEDGE_BASE_ID is missing in .env");
        return;
    }

    console.log(`🔍 Testing Knowledge Base: ${kbId}`);

    try {
        const command = new RetrieveCommand({
            knowledgeBaseId: kbId,
            retrievalQuery: {
                text: "What is NavGurukul?", // Common query to test
            },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: 3,
                },
            },
        });

        const response = await client.send(command);

        if (response.retrievalResults && response.retrievalResults.length > 0) {
            console.log(`✅ Success! Found ${response.retrievalResults.length} relevant chunks.`);
            response.retrievalResults.forEach((result, i) => {
                console.log(`--- Chunk ${i + 1} ---`);
                console.log(result.content?.text?.substring(0, 200) + "...");
            });
        } else {
            console.log("❌ No results found. Your Knowledge Base might be empty or not yet synced.");
            console.log("💡 Tip: Try clicking the 'Sync Database' button in the UI or check the AWS Console ingestion status.");
        }
    } catch (error) {
        console.error("❌ Error during retrieval:", error);
    }
}

testRetrieval();
