# Notion AI Chat Assistant

A premium AI-powered web application that allows users to chat with a Notion workspace exported into an S3-backed Amazon Bedrock Knowledge Base. Users authenticate with Google, ask questions in the chat UI, and receive ai-powered answers grounded in retrieved Notion context.

## 🌟 Purpose

The **Notion AI Chat Assistant** is designed to bridge the gap between static Notion documentation and interactive information retrieval. Instead of manually searching through rows and pages, users can ask natural language questions and receive accurate, context-aware answers derived directly from their personal or shared Notion databases.

## ✨ Features

-   **Google OAuth Login**: Seamless authentication using `next-auth`.
-   **Notion Workspace Export**: Manual Notion-to-S3 export script using the official Notion SDK.
-   **Bedrock Knowledge Base Retrieval**: S3-backed RAG retrieval through Amazon Bedrock Knowledge Bases.
-   **AI Engine**: Use Gemini or DeepSeek for high-speed, intelligent responses.
-   **Premium Design**: A high-end dark mode interface built with Tailwind CSS and glassmorphism.
-   **Context-Aware**: AI responses are strictly grounded in your Notion database content.

## 🚀 Getting Started

### Prerequisites

You will need the following API keys:
-   **Google Cloud Console**: For OAuth Client ID and Secret.
-   **Notion Integrations**: For the Internal Integration Token.
-   **AWS**: For S3 and Bedrock Knowledge Base access.
-   **Google AI Studio**: For the Gemini API Key (if using Gemini).
-   **DeepSeek**: For the DeepSeek API Key (if using DeepSeek).

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

5.  Export the Notion workspace to S3 when content changes:
    ```bash
    npm run export:notion
    ```

6.  Start Bedrock ingestion from the app's sync button, or verify retrieval directly:
    ```bash
    npm run test:bedrock
    ```

7.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🛠 Tech Stack

-   **Framework**: [Next.js](https://nextjs.org/) (App Router)
-   **Authentication**: [NextAuth.js](https://next-auth.js.org/)
-   **AI**: Gemini via [Google Gemini SDK](https://ai.google.dev/) or DeepSeek via API
-   **RAG**: Amazon Bedrock Knowledge Bases backed by S3
-   **Workspace Export**: [@notionhq/client](https://www.npmjs.com/package/@notionhq/client)
-   **Styling**: Tailwind CSS & Lucide Icons

## 📜 License

This project is licensed under the GPL 3 License - see the [LICENSE](LICENSE) file for details.
