# Architecture Overview

The Notion AI Chat Assistant uses a **RAG (Retrieval-Augmented Generation)** pattern to provide accurate answers based on your Notion data.

## High-Level Flow

1. **Notion Ingestion & Chunking**: Workspace pages from Notion are stored and chunked into PostgreSQL with `pgvector` embeddings (`text-embedding-3-small`).
2. **Intent Classification & Routing**: Incoming queries are parsed via regex rules or OpenAI intent classification (`gpt-4o-mini`).
3. **Context Retrieval & SQL Execution**: The backend routes queries to direct SQL answers or vector-hybrid RAG retrieval.
4. **AI Response Streaming**: Context and prompt are sent to OpenAI (`gpt-4o-mini`), which streams back the response to the user.

## End-to-End Chat Flow

The diagram below follows one question from the browser to the answer. Each numbered stage shows the data produced by that stage, the next decision, and the owning implementation. A question can finish early, but every normal knowledge question continues through intent resolution, SQL routing, retrieval, grounded generation, persistence, and client refresh.

```mermaid
flowchart TD
    START([1. User asks a question]) --> CLIENT["Build request: message + history + sessionId\nsrc/app/page.tsx"]
    CLIENT --> HTTP["POST /api/chat\nsrc/app/api/chat/route.ts"]
    HTTP --> AUTH["2. Authenticate request\nrequireSession()\nsrc/lib/auth/session.ts"]
    AUTH -->|unauthenticated| ERR401([Return auth response])
    AUTH --> LIMIT["3. Rate-limit by user email\nsrc/lib/shared/rate-limit.ts"]
    LIMIT -->|blocked| ERR429([Return 429 + retry-after])
    LIMIT --> PARSE["4. Parse JSON body and dispatch\nmessage, history, sessionId, regenerate\nsrc/app/api/chat/route.ts"]
    PARSE --> HANDLE["Map validation, missing chat, and provider errors\nsrc/lib/chat/handler.ts"]
    HANDLE --> VALIDATE["5. Validate message and sanitize history\nCreate request telemetry\nsrc/lib/chat/pipeline.ts\nsrc/lib/chat/telemetry.ts"]

    VALIDATE --> FAST{"6. Instant regex route?\nsmalltalk / greeting\nsrc/lib/chat/smalltalk.ts"}
    FAST -->|yes| FASTSAVE["Save user + bot message if session exists\nsrc/lib/chat/store.ts"]
    FASTSAVE --> JSON["Return JSON answer"]
    FAST -->|no| UTILITY{"7. Identity or date/time utility?\nsrc/lib/chat/pipeline.ts"}
    UTILITY -->|yes| UTILITYSAVE["Compute utility answer; detect emotion;\nattach session and save messages"]
    UTILITYSAVE --> JSON
    UTILITY -->|no| PREP["8. Prepare question context\nExtract last entities from history\nStart emotion analysis in parallel\nsrc/lib/chat/smalltalk.ts\nsrc/lib/chat/emotion.ts"]
    PREP --> SESSION["9. Attach session\nVerify ownership; save user message\nLoad persisted session state\nsrc/lib/chat/store.ts"]
    SESSION --> MERGE["Merge history entities + DB state\nlast person, project, gender-aware references\nsrc/lib/chat/pipeline.ts"]
    MERGE --> CORRECTION{"10. Is this a correction or\nwrong-answer retry?\nsrc/lib/chat/correction.ts"}
    CORRECTION -->|clarification needed| CLARIFY["Return clarifying question\nsrc/lib/chat/correction.ts"]
    CORRECTION -->|rewrite available| REWRITE["Replace query and mark retry\nKeep corrected person/project"]
    CORRECTION -->|no| QUERY["Use original query"]
    REWRITE --> RESOLVE
    QUERY --> RESOLVE
    RESOLVE["11. Resolve query\nRegex rules -> optional LLM intent classifier\nFollow-up reformulation -> fill entities from history\nsrc/lib/query/resolve-query.ts\nsrc/lib/query/intent.ts\nsrc/lib/chat/query-tools.ts"] --> CONTEXT["Build PipelineContext\nmessage, history, entities, intent, reformulatedQuery"]
    CONTEXT --> LINK{"12. Notion link request?\nsrc/lib/chat/query-tools.ts"}
    LINK -->|yes| LINKLOOKUP["Lookup page URL by exact title\n(or return link guidance)\nsrc/lib/sql/answers.ts"]
    LINKLOOKUP --> JSON
    LINK -->|no| SMALL{"13. Smalltalk intent?\nsrc/lib/chat/pipeline.ts"}
    SMALL -->|yes| SMALLSTREAM["Warm fallback or OpenAI conversational stream"]
    SMALLSTREAM --> STREAM
    SMALL -->|no| SQLSTART["14. Resolve SQL entities lazily\nName/page matching and ambiguity check\nsrc/lib/chat/sql-answer.ts\nsrc/lib/query/entity-resolver.ts"]
    SQLSTART --> SQLQUERY["Execute metadata query against notion_pages\nactivity, ownership, status, roster, analytics\nsrc/lib/sql/answers.ts\nsrc/lib/sql/activity.ts"]
    SQLQUERY --> SQLPOLICY{"15. Does routing policy trust SQL result?\nsrc/lib/chat/routing-policy.ts"}
    SQLPOLICY -->|clarification| CLARIFYSQL["Return entity clarification question"]
    SQLPOLICY -->|metadata hit| SQLJSON["Return direct JSON answer"]
    SQLPOLICY -->|synthesis hit| SQLSYNTH["Use SQL result as context\nStream OpenAI synthesis"]
    SQLPOLICY -->|miss / weak / semantic| RAGSTART["16. Enter RAG fallback"]
    SQLSYNTH --> STREAM

    RAGSTART --> RAGENTITY["Resolve RAG entities and block unsupported metadata-only requests\nsrc/lib/chat/rag-answer.ts\nsrc/lib/query/entity-resolver.ts"]
    RAGENTITY --> RAGPLAN["17. Build search plan\nTitle boost, explicit page, year, history entity\nChoose original/reformulated query"]
    RAGPLAN --> EXPAND{"Need query expansion or retry broadening?"}
    EXPAND -->|yes| EXPANDLLM["Reformulate and/or expand search queries\nReuse prior reformulation when available\nsrc/lib/chat/query-tools.ts"]
    EXPAND -->|no| SEARCHINPUT["Use one search query"]
    EXPANDLLM --> SEARCHINPUT
    SEARCHINPUT --> PREFETCH["18. Prefetch matching pages\nLIKE / FTS title and content search\nUp to 12 page records\nsrc/lib/rag/build-context.ts"]
    SEARCHINPUT --> HYBRID["19. Retrieve chunks\nEmbed query with text-embedding-3-small\nVector candidates + FTS/trigram candidates\nsrc/lib/rag/hybrid-search.ts\nsrc/lib/rag/semantic-search.ts"]
    PREFETCH --> ASSEMBLE["20. Assemble grounded context\nMerge page metadata + chunk hits\nDeduplicate, relevance floor, MMR, context limit\nsrc/lib/rag/build-context.ts"]
    HYBRID --> DB[("PostgreSQL\nnotion_pages + notion_chunks\npgvector + FTS/trigram")]
    DB --> ASSEMBLE
    ASSEMBLE --> CONF{"21. Retrieval confidence and evidence?\nsrc/lib/rag/build-context.ts"}
    CONF -->|empty| NORESULT["Return synced-database guidance"]
    CONF -->|weak| RETRY["Broaden queries, remove year/hints,\nloosen threshold for wrong-answer retry"]
    RETRY --> PREFETCH
    RETRY --> HYBRID
    CONF -->|strong| GROUNDED["Grounded context ready\nquestion + context + conversation history"]
    CONF -->|still weak| REFUSAL["Return retrieval refusal\nDo not invent an answer"]

    GROUNDED --> STREAM
    STREAM["22. Build answer prompt\nStyle + status/synthesis/boolean directives\nCall OpenAI gpt-4o-mini\nsrc/lib/chat/stream-response.ts\nsrc/lib/ai/openai.ts"] --> TOKENS["23. Stream response chunks\nBrowser receives text progressively\nExtract final answer from stream tags\nsrc/lib/chat/stream-tags.ts"]
    TOKENS --> STORE["24. Persist completed bot answer\nSave telemetry, route, latency, confidence\nsrc/lib/chat/store.ts\nsrc/lib/chat/telemetry.ts"]
    JSON --> STORE
    SQLJSON --> STORE
    CLARIFY --> STORE
    CLARIFYSQL --> STORE
    NORESULT --> STORE
    REFUSAL --> STORE
    STORE --> CLIENTANSWER["25. Update visible message\nParse JSON or consume text stream\nsrc/app/page.tsx"]
    CLIENTANSWER --> REFRESH["Reload messages and chat list\n/api/chats/[sessionId]/messages\nsrc/app/page.tsx"]
    REFRESH --> END([Answer displayed and stored])
```

## Supporting Ingestion Flow

The answering path depends on this separate sync path having populated the database and search index first.

```mermaid
flowchart LR
    N[Notion workspace] --> FETCH["Fetch pages and properties\nsrc/lib/ingestion/sync.ts"]
    FETCH --> NORMALIZE["Normalize and chunk page content\nsrc/lib/ingestion/chunk.ts"]
    NORMALIZE --> META["Upsert page metadata and chunks\nsrc/lib/db/index.ts\nsrc/lib/db/postgres.ts"]
    NORMALIZE --> EMBED["Create text embeddings\nsrc/lib/ai/embeddings.ts"]
    EMBED --> META
    META --> READY[("notion_pages + notion_chunks\nPostgreSQL / pgvector")]
```

## Key Tech Choices

- **Next.js**: For both the frontend UI and serverless API routes.
- **NextAuth**: For secure Google OAuth handling.
- **Neon PostgreSQL + pgvector**: For SQL metadata storage and vector similarity retrieval.
- **Notion SDK**: Official client for workspace sync.
- **OpenAI SDK**: Sole AI provider for embeddings (`text-embedding-3-small`), intent classification, and chat streaming (`gpt-4o-mini`).
