import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const client = new BedrockAgentRuntimeClient({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

export async function retrieveNotionContext(query: string) {
    try {
        const command = new RetrieveCommand({
            knowledgeBaseId: process.env.AWS_KNOWLEDGE_BASE_ID!,
            retrievalQuery: {
                text: query,
            },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: 5, // Number of relevant chunks to retrieve
                },
            },
        });

        const response = await client.send(command);

        // Combine the results into a single context string
        const context = response.retrievalResults
            ?.map((result) => result.content?.text)
            .filter(Boolean)
            .join("\n\n---\n\n");

        return context || "";
    } catch (error) {
        console.error("AWS Retrieval Error:", error);
        throw error;
    }
}
