import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";

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
          numberOfResults: 20,  // Increased to cast wider net
        },
      },
    });

    const response = await client.send(command);

    console.log(`📡 Bedrock returned ${response.retrievalResults?.length || 0} chunks`);

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

const agentClient = new BedrockAgentClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export async function syncBedrockKnowledgeBase() {
  const knowledgeBaseId = process.env.AWS_KNOWLEDGE_BASE_ID;
  const dataSourceId = process.env.AWS_DATA_SOURCE_ID;

  if (!knowledgeBaseId || !dataSourceId) {
    throw new Error("AWS_KNOWLEDGE_BASE_ID or AWS_DATA_SOURCE_ID is missing in environment variables");
  }

  try {
    const command = new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
    });

    const response = await agentClient.send(command);
    return response.ingestionJob;
  } catch (error) {
    console.error("AWS Ingestion Error:", error);
    throw error;
  }
}
