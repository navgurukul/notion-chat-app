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

The current exporter uses Notion workspace search and uploads all accessible pages to S3. Make sure the integration is connected to the workspace/pages that should be searchable.

### AWS Bedrock Knowledge Base
- `AWS_REGION`: AWS region for S3 and Bedrock.
- `AWS_ACCESS_KEY_ID`: AWS access key with S3 and Bedrock Knowledge Base permissions.
- `AWS_SECRET_ACCESS_KEY`: AWS secret key.
- `S3_BUCKET_NAME`: Bucket used by the Notion export script.
- `AWS_KNOWLEDGE_BASE_ID`: Bedrock Knowledge Base ID.
- `AWS_DATA_SOURCE_ID`: Bedrock data source ID.

After exporting Notion content with `npm run export:notion`, start ingestion from the app's sync button and verify retrieval with `npm run test:bedrock`.

### AI Provider
- Chat uses OpenAI (same `OPENAI_API_KEY` already used for embeddings).
- `OPENAI_CHAT_MODEL`: OpenAI chat model name (example: `gpt-4o-mini`).

## 🔗 Connecting Notion
1. Go to your Notion Database.
2. Click the `...` in the top right.
3. Select `Add connections` and find your Integration name.
