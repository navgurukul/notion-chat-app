# Archived / legacy files

These files were moved here during the Postgres + pgvector refactor. They are **not** used by the main app (`src/app`, active `src/lib`).

| Path | What it was |
|------|-------------|
| `src/lib/aws.ts` | Amazon Bedrock Knowledge Base retrieval |
| `src/lib/debug.ts` | Debug route helpers |
| `src/lib/query/index.ts` | Unused query barrel export |
| `src/app/api/test/` | Env health debug API |
| `src/app/api/debug-context/` | Bedrock context debug API |
| `src/app/api/debug-bedrock/` | Bedrock retrieve debug API |
| `scripts/test-bedrock.ts` | CLI Bedrock test |
| `scripts/benchmark-chatbot.ts` | Bedrock + Gemini benchmark |
| `scripts/scripts/notion-to-s3.ts` | Notion → S3 export (legacy; active copy: `scripts/notion-to-s3.ts`) |
| `public/*.svg` | Unused Next.js default icons |
| `EXPORT_SUMMARY.md` | S3 export coverage notes |

To use a script again, copy it back or fix import paths (they originally assumed repo-root layout).
