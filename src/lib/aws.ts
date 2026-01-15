import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

const client = new BedrockAgentRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
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
          numberOfResults: 5,
        },
      },
    });

    const response = await client.send(command);

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

