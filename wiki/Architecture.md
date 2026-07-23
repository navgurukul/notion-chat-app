# Architecture Overview

The Notion AI Chat Assistant uses a **RAG (Retrieval-Augmented Generation)** pattern to provide accurate answers based on your Notion data.

## 🏗 High-Level Flow

1. **Workspace Export**: A manual script exports accessible Notion workspace pages to JSON files under the S3 `notion/pages/` prefix.
2. **Bedrock Ingestion**: The app sync button starts an Amazon Bedrock Knowledge Base ingestion job for the configured S3 data source.
3. **User Input**: The user sends a question through the chat interface.
4. **Context Retrieval**: The server-side API retrieves relevant chunks from the Bedrock Knowledge Base.
5. **AI Generation**: The prompt (user question plus retrieved context) is sent to OpenAI.
6. **Response**: OpenAI streams an answer grounded in the retrieved Notion context.

## 🛠 Key Tech Choices

- **Next.js**: For both the frontend UI and server API routes.
- **Tailwind CSS**: For the premium, responsive design.
- **NextAuth**: For secure Google OAuth handling.
- **PostgreSQL + pgvector**: For hybrid vector and full-text retrieval.
- **Notion SDK**: Official client for workspace export and sync.
- **OpenAI SDK**: Direct access to OpenAI GPT and Embedding models.
