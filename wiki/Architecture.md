# Architecture Overview

The Notion AI Chat Assistant uses a **RAG (Retrieval-Augmented Generation)** pattern to provide accurate answers based on your Notion data.

## 🏗 High-Level Flow

1. **User Input**: The user sends a question through the chat interface.
2. **Context Retrieval**: The server-side API fetches the latest data from the specified Notion database using the Notion SDK.
3. **Context Processing**: The extracted text is formatted and used as context for the AI model.
4. **AI Generation**: The prompt (User Question + Notion Context) is sent to Gemini 1.5 Flash.
5. **Response**: The AI generates a response based *only* on the provided context and sends it back to the UI.

## 🛠 Key Tech Choices

- **Next.js 15**: For both the frontend UI and the serverless API routes.
- **Tailwind CSS**: For the premium, responsive design.
- **NextAuth**: For secure Google OAuth handling.
- **Notion SDK**: Official client for reliable data fetching.
- **Google Generative AI SDK**: Direct access to Gemini models.
