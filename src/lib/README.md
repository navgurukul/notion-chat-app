# Library layout (`src/lib`)

Everything lives in a **folder**. The only file at this level is this README.

## Big picture

```
User question (browser)
        │
        ▼
   chat/          ← orchestration (start here)
        │
        ├── query/     ← what kind of question? (SQL vs RAG)
        │
        ├── sql/       ← direct Postgres answers
        │
        └── rag/ + ai/ ← search Notion + Gemini
                ▲
                │
         ingestion/    ← sync Notion, chunk, embed (background)

   auth/  db/  shared/  ← used by all layers above
```

## Feature folders

| Folder | Purpose | Start reading |
|--------|---------|---------------|
| **chat/** | Message → JSON or stream; sessions; stream tags | `chat/pipeline.ts` |
| **query/** | Classify intent (`status_of`, `semantic`, …) | `query/resolve-query.ts` |
| **sql/** | Structured answers from `notion_pages` | `sql/answers.ts` |
| **rag/** | Retrieve context for open questions | `rag/build-context.ts` |
| **ai/** | Gemini chat + embeddings | `ai/gemini.ts` |
| **ingestion/** | Notion sync → DB + chunks | `ingestion/sync.ts` |

## Infrastructure folders

| Folder | Files | Purpose |
|--------|-------|---------|
| **auth/** | `options.ts`, `session.ts` | Google login + `requireSession()` for API routes |
| **db/** | `postgres.ts`, `sql-utils.ts` | Database pool, schema, `query()`, SQL escaping |
| **shared/** | `notion-types.ts`, `search-query.ts`, `rate-limit.ts` | Types and small helpers used by many layers |

## API routes (thin wrappers)

| Route | Imports |
|-------|---------|
| `app/api/chat/route.ts` | `@/lib/chat/handler`, `@/lib/auth`, `@/lib/shared/rate-limit` |
| `app/api/sync/route.ts` | `@/lib/ingestion`, `@/lib/db` |
| `app/api/chats/*` | `@/lib/chat/store`, `@/lib/auth` |

## Example imports

```ts
import { handleChatPost } from "@/lib/chat/handler";
import { resolveQuery } from "@/lib/query";
import { handleMetadataQuery } from "@/lib/sql/answers";
import { buildNotionContextForChat } from "@/lib/rag";
import { query } from "@/lib/db";
import { requireSession } from "@/lib/auth";
```

## Scripts

| Script | Layer |
|--------|--------|
| `scripts/sync-notion.ts` | ingestion |
| `scripts/embed-missing.ts` | ai + db |
| `scripts/verify-chat-routes.ts` | query + sql + rag |
| `scripts/e2e-pipeline-test.ts` | chat + query + sql + rag |
