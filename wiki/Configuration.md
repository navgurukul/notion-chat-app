# Configuration Details

To use the Notion AI Chat Assistant, you need to provide several API keys and identifiers.

## 🔑 Required Environment Variables

### Google Authentication
- `GOOGLE_CLIENT_ID`: Obtained from the [Google Cloud Console](https://console.cloud.google.com/).
- `GOOGLE_CLIENT_SECRET`: Obtained from the Google Cloud Console.
- `NEXTAUTH_SECRET`: A random string used to encrypt the session.
- `NEXTAUTH_URL`: The base URL of your application (e.g., `http://localhost:3000`).

### Notion API
- `NOTION_TOKEN`: Find this in your [Notion Integrations](https://www.notion.so/my-integrations).
- `NOTION_DATABASE_ID`: The ID of the database you want to chat with. 
  > [!TIP]
  > The ID is the part of the URL after the workspace name and before the `?v=`.

### Gemini AI
- `GEMINI_API_KEY`: Obtained from [Google AI Studio](https://aistudio.google.com/).

## 🔗 Connecting Notion
1. Go to your Notion Database.
2. Click the `...` in the top right.
3. Select `Add connections` and find your Integration name.
