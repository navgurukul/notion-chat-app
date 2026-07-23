# Notion AI Chat Assistant

A premium AI-powered web application that allows users to chat with a Notion workspace exported into an S3-backed Amazon Bedrock Knowledge Base. Users authenticate with Google, ask questions in the chat UI, and receive ai-powered answers grounded in retrieved Notion context.

## 🌟 Purpose

The **Notion AI Chat Assistant** is designed to bridge the gap between static Notion documentation and interactive information retrieval. Instead of manually searching through rows and pages, users can ask natural language questions and receive accurate, context-aware answers derived directly from their personal or shared Notion databases.

## ✨ Features

-   **Google OAuth Login**: Seamless authentication using `next-auth`.
-   **Notion Workspace Export**: Manual Notion-to-S3 export script using the official Notion SDK.
-   **Hybrid Vector & SQL Search**: Direct Postgres SQL lookup and vector search context retrieval.
-   **AI Engine**: Unified OpenAI provider (`gpt-4o-mini` / `text-embedding-3-small`) for fast, intelligent responses.
-   **Premium Design**: A high-end interface built with modern CSS and dynamic animations.
-   **Context-Aware**: AI responses are strictly grounded in your Notion database content.

## 🚀 Getting Started

### Prerequisites

You will need the following API keys:
-   **Google Cloud Console**: For OAuth Client ID and Secret.
-   **Notion Integrations**: For the Internal Integration Token.
-   **OpenAI**: For `OPENAI_API_KEY` (used for embeddings, intent resolution, and response generation).

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/navgurukul/notion-chat-app.git
    cd notion-chat-app
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Setup Environment Variables:
    Copy `.env.example` to `.env.local` and fill in your keys:
    ```bash
    cp .env.example .env.local
    ```

4.  Run the development server:
    ```bash
    npm run dev
    ```

5.  Run E2E pipeline test suite:
    ```bash
    npm run test:e2e
    ```

6.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🛠 Tech Stack

-   **Framework**: [Next.js](https://nextjs.org/) (App Router)
-   **Authentication**: [NextAuth.js](https://next-auth.js.org/)
-   **AI**: [OpenAI SDK](https://platform.openai.com/docs/api-reference) (Embeddings, Completions, and Streaming)
-   **Database**: Neon PostgreSQL with `pgvector`
-   **Workspace Export**: [@notionhq/client](https://www.npmjs.com/package/@notionhq/client)

## 📜 License

This project is licensed under the GPL 3 License - see the [LICENSE](LICENSE) file for details.
