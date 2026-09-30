# Architecture Overview

The Notion AI Chat Assistant uses a **RAG (Retrieval-Augmented Generation)** pattern to provide accurate answers based on your Notion data.

## 🏗 High-Level Flow

1. **Notion Ingestion & Chunking**: Workspace pages from Notion are stored and chunked into PostgreSQL with `pgvector` embeddings (`text-embedding-3-small`).
2. **Intent Classification & Routing**: Incoming queries are parsed via regex rules or OpenAI intent classification (`gpt-4o-mini`).
3. **Context Retrieval & SQL Execution**: The backend routes queries to direct SQL answers or vector-hybrid RAG retrieval.
4. **AI Response Streaming**: Context and prompt are sent to OpenAI (`gpt-4o-mini`), which streams back the response to the user.

## 🔁 Full Data Flow

```mermaid
flowchart LR
	subgraph A[Ingestion]
		N[Notion pages] --> S[Sync job]
		S --> C[Chunk + normalize text]
		C --> E[Create embeddings]
		C --> M[Store SQL metadata]
		E --> V[(PostgreSQL + pgvector)]
		M --> V
	end

	subgraph B[Question Answering]
		U[User] --> UI[Chat UI]
		UI --> API[/api/chat/]
		API --> AUTH[Session + rate limit]
		AUTH --> P[Parse intent + entities]
		P -->|SQL lane| SQL[trySqlAnswer]
		P -->|RAG lane| RAG[tryRagAnswer]
		SQL -->|direct answer| RESP[Stream or JSON answer]
		RAG --> Q[Reformulate + expand query]
		Q --> R[Hybrid retrieval]
		R --> V
		V --> R
		R -->|low confidence retry| RR[Broadened retry]
		RR --> V
		R --> LLM[OpenAI gpt-4o-mini]
		LLM --> RESP
		RESP --> UI
		RESP --> DB[Persist bot message]
	end
```

```mermaid
sequenceDiagram
	autonumber
	actor User
	participant Browser as Chat UI
	participant API as /api/chat
	participant Router as resolveQuery
	participant SQL as trySqlAnswer
	participant RAG as tryRagAnswer
	participant Notion as PostgreSQL + pgvector
	participant LLM as OpenAI gpt-4o-mini

	User->>Browser: Send message
	Browser->>API: POST { message, history, sessionId }
	API->>Router: sanitize history + classify intent
	Router-->>API: ParsedQuery + route decision

	alt SQL lane / metadata hit
		API->>SQL: handleMetadataQuery(parsed)
		SQL-->>API: Direct answer JSON
		API-->>Browser: answer + emotion
	else SQL miss or RAG lane
		API->>RAG: resolve entities + build search plan
		RAG->>Notion: hybrid search over SQL metadata + embeddings
		Notion-->>RAG: chunk hits + confidence
		alt confidence too low
			RAG->>Notion: broadened retry query
			Notion-->>RAG: retry hits
		end
		RAG->>LLM: streamOpenAIAnswer(context, history, queryKind)
		LLM-->>RAG: streamed tokens
		RAG-->>API: streaming response
		API-->>Browser: final answer
	end
```

## 🛠 Key Tech Choices

- **Next.js**: For both the frontend UI and serverless API routes.
- **NextAuth**: For secure Google OAuth handling.
- **Neon PostgreSQL + pgvector**: For SQL metadata storage and vector similarity retrieval.
- **Notion SDK**: Official client for workspace sync.
- **OpenAI SDK**: Sole AI provider for embeddings (`text-embedding-3-small`), intent classification, and chat streaming (`gpt-4o-mini`).
