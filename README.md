# Notion AI Chat Assistant

A premium AI-powered web application that allows users to chat with their Notion databases. Users can authenticate using their Google accounts to interact with their Notion data through a sleek, modern interface powered by Gemini 1.5 Flash.

## 🌟 Purpose

The **Notion AI Chat Assistant** is designed to bridge the gap between static Notion documentation and interactive information retrieval. Instead of manually searching through rows and pages, users can ask natural language questions and receive accurate, context-aware answers derived directly from their personal or shared Notion databases.

## ✨ Features

-   **Google OAuth Login**: Seamless authentication using `next-auth`.
-   **Notion Integration**: Real-time content fetching from Notion databases using the official SDK.
-   **Gemini AI Engine**: Leveraging Google's Gemini 1.5 Flash for high-speed, intelligent responses.
-   **Premium Design**: A high-end dark mode interface built with Tailwind CSS and glassmorphism.
-   **Context-Aware**: AI responses are strictly grounded in your Notion database content.

## 🚀 Getting Started

### Prerequisites

You will need the following API keys:
-   **Google Cloud Console**: For OAuth Client ID and Secret.
-   **Notion Integrations**: For the Internal Integration Token.
-   **Google AI Studio**: For the Gemini API Key.

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

5.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🛠 Tech Stack

-   **Framework**: [Next.js](https://nextjs.org/) (App Router)
-   **Authentication**: [NextAuth.js](https://next-auth.js.org/)
-   **AI**: [Google Gemini SDK](https://ai.google.dev/)
-   **Database API**: [@notionhq/client](https://www.npmjs.com/package/@notionhq/client)
-   **Styling**: Tailwind CSS & Lucide Icons

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
