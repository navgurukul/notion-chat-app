# Software Design & Architecture Diagrams
**Project:** Notion AI Chat Assistant
**Scope:** Architecture, Ingestion Pipeline, and Query Routing Data Flow

---

## 1. High-Level System Architecture
This diagram illustrates the overall system components, authentication middleware, API route layer, and interactions with external services (Notion API, LLM/Embedding providers).

```mermaid
graph TB
    subgraph Client Layer [Client Application]
        UI[Next.js Client SPA]
    end

    subgraph Authentication Gate [Security & Auth]
        Middleware{Next.js Middleware}
        NextAuth[NextAuth.js Google OAuth]
        RateLimit[Rate Limiter]
    end

    subgraph Application Backend [Next.js App Router]
        API_Chat[/api/chat POST]
        API_Chats[/api/chats GET/POST/DELETE]
        API_Sync[/api/sync GET/POST]
        API_Cost[/api/cost-report GET]
        
        SyncService[Notion Sync Service]
        Pipeline[Chat Pipeline Runner]
        SQLAnswers[SQL Answers Engine]
    end

    subgraph Knowledge Base Ingestion [Data Ingest]
        Chunker[Semantic Chunker]
        EmbedBatch[Embedding Batcher]
    end

    subgraph Data Stores [Database Layer]
        Postgres[(PostgreSQL DB)]
        pgvector[(pgvector Extension)]
    end

    subgraph External Services [SaaS APIs]
        NotionAPI[[Notion SDK / API]]
        LLM[[Gemini / DeepSeek API]]
    end

    %% Client and Auth Flow
    UI -->|Navigate / API request| Middleware
    Middleware -->|Require Session| NextAuth
    NextAuth -->|Allow Domain Check| UI
    UI -->|POST /api/chat| RateLimit
    RateLimit -->|If Allowed| API_Chat

    %% API Routes Interactions
    API_Chat --> Pipeline
    API_Sync --> SyncService
    API_Cost --> Postgres

    %% Sync / Ingestion Flow
    SyncService -->|1. Fetch Pages| NotionAPI
    SyncService -->|2. Extract Blocks| NotionAPI
    SyncService -->|3. Chunk Pages| Chunker
    Chunker -->|4. Generate Vectors| EmbedBatch
    EmbedBatch -->|5. Vector APIs| LLM
    SyncService -->|6. Batch Insert UNNEST| Postgres

    %% Pipeline and Query Routing
    Pipeline -->|Intent Detection| LLM
    Pipeline -->|Semantic Retrieval| pgvector
    Pipeline -->|Metadata Retrieval| SQLAnswers
    SQLAnswers --> Postgres
    Pipeline -->|Final Context Prompt| LLM
    LLM -->|Stream Answer| UI

    classDef store fill:#3b82f6,stroke:#1d4ed8,color:#fff;
    classDef ext fill:#10b981,stroke:#047857,color:#fff;
    class Postgres,pgvector store;
    class NotionAPI,LLM ext;
```

---

## 2. Ingestion & Synchronization Pipeline (Notion -> DB)
This flowchart shows how the system reads content from Notion workspace databases, splits it into semantic chunks, generates vectors, and upserts them to PostgreSQL in concurrency-controlled batches.

```mermaid
sequenceDiagram
    autonumber
    actor Admin as tamanna@navgurukul.org
    participant API as /api/sync Route
    participant Sync as Notion Sync Service
    participant Notion as Notion API Client
    participant DB as PostgreSQL Client
    participant AI as Gemini/OpenAI Embedding API

    Admin->>API: POST /api/sync?embed=true
    API->>Sync: syncNotionToPostgres({ embed: true })
    Sync->>DB: Reset stuck 'processing' pages
    Sync->>Notion: fetchAllPages() (Search API)
    Notion-->>Sync: Return page list (IDs & Metadata)
    
    Note over Sync, Notion: Concurrency-limited processing (Default: 8 parallel tasks)
    
    loop For each page in parallel
        Sync->>Notion: fetchBlocksRecursively(pageId)
        Notion-->>Sync: Return nested markdown block lines
        Sync->>DB: Upsert page metadata with status = 'processing'
        
        opt When Embeddings Enabled
            Sync->>AI: embedBatch([pageString])
            AI-->>Sync: Return 768/1536-dim page vector
        end
        
        Sync->>Sync: chunkPageContent() (Header paths, char/token count)
        
        opt When Embeddings Enabled for Chunks
            Sync->>AI: embedBatch([chunk1, chunk2, ...])
            AI-->>Sync: Return chunk vectors
        end

        Sync->>DB: BEGIN Transaction
        Sync->>DB: DELETE FROM notion_chunks WHERE page_id = pageId
        Sync->>DB: Bulk INSERT UNNEST(chunks & embeddings)
        Sync->>DB: COMMIT Transaction
        Sync->>DB: Update page status = 'completed'
    end

    Sync-->>API: Return SyncResult (upserted, skipped, failed counts)
    API-->>Admin: 200 OK Response
```

---

## 3. Query Routing & Resolution Pipeline (/api/chat)
This diagram illustrates the hybrid routing engine. The system routes questions through smalltalk fast-paths, Notion page link matches, dynamic metadata queries, or falls back to hybrid semantic search + streaming LLM grounding.

```mermaid
graph TD
    Start([Incoming User Question]) --> Sanitize[Sanitize & Validate Input]
    Sanitize --> Session[Attach Session & Save History in DB]
    Session --> Emotion[Analyze Sentiment / Tone in Parallel]
    
    %% Lane 1: Fast-Path
    Emotion --> FastPath{1. Matches Smalltalk Regex?}
    FastPath -->|Yes| ST_Response[Return Smalltalk Answer] --> End([End Response])
    
    %% Lane 2: Notion Link Lookup
    FastPath -->|No| LinkCheck{2. Notion Link request?}
    LinkCheck -->|Yes| LinkLookup[Lookup page title in notion_pages]
    LinkLookup --> LinkFound{Found?}
    LinkFound -->|Yes| LinkResponse[Return exact page URL & metadata] --> End
    LinkFound -->|No| LinkRefusal[Return page-not-found helper text] --> End

    %% Lane 3: Intent Classification
    LinkCheck -->|No| Intent[3. LLM Intent Classifier + Timeouts]
    Intent --> IntentKind{Intent Kind?}

    %% Sub-Lane 3a: SQL Metadata
    IntentKind -->|metadata / project_scope / roster / activity| SQLAttempt[Execute trySqlAnswer]
    SQLAttempt --> SQLSuccess{SQL Returned Results?}
    SQLSuccess -->|Yes| SQLFormat[Format SQL table data to markdown]
    SQLFormat --> StreamLLM[Stream response grounded in SQL data] --> End
    SQLSuccess -->|No| RAGFallback[Fallback to RAG Retrieval]

    %% Sub-Lane 3b: Semantic / Page Info / RAG Lane
    IntentKind -->|semantic / page_about / list / fallback| RAGFallback
    
    %% RAG Retrieval
    RAGFallback --> Expand[4. Multi-Query Expansion via LLM]
    Expand --> Search[5. Hybrid Search: Vector Sim + FTS + Title Boost]
    Search --> MMR[6. Deduplication & Maximal Marginal Relevance selection]
    MMR --> Confidence{7. Retrieval Confidence OK?}
    
    Confidence -->|No| Refuse[Return default refusal message] --> End
    Confidence -->|Yes| GroundPrompt[8. Construct grounded prompt with notionContext]
    GroundPrompt --> GroundLLM[9. Stream grounded LLM Answer] --> End
```
