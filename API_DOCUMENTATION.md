# Notion Chat App — API Documentation (end-to-end, section-wise)

This document describes **every API route implemented under `src/app/api/*`**, in a **start-to-end flow** style.

> Base URL (Next.js): `/api/*`

---

## 0) Authentication & Session Model (Auth Section)

### 0.1 NextAuth endpoints

#### Endpoint
- **`GET /api/auth/*`**
- **`POST /api/auth/*`**

#### Implemented in
- `src/app/api/auth/[...nextauth]/route.ts`

#### What it does
This route exports the NextAuth handler as both **GET** and **POST**, so NextAuth can:
- initiate OAuth sign-in
- process OAuth callbacks
- create and manage sessions

No additional request/response schema is implemented in this repo layer; NextAuth owns it.

---

### 0.2 Sign-in allowed-domain gate

#### Implemented in
- `src/lib/auth/options.ts`
- `src/lib/shared/navgurukul-domain.ts`

#### Domain rule
- `ALLOWED_EMAIL_DOMAIN` environment variable determines the allowed email domain.
- If unset, default allowed domain is: `navgurukul.org`.
- The check is effectively: `email.endsWith(@<allowed-domain>)`.

#### Effect
- Users outside the allowed domain are blocked during sign-in (via NextAuth `callbacks.signIn`).

---

### 0.3 UI protection vs API protection

#### UI protection (middleware)
- Implemented in: `src/app/middleware.ts`

Middleware runs for browser navigation except for exclusions like:
- `/login`
- `api/auth` (NextAuth)
- static assets

Behavior:
1. Calls `getServerSession(authOptions)`.
2. If no session → redirects to `/login`.
3. If session exists → enforces allowed email domain; if forbidden returns `403`.
4. Otherwise request continues.

#### API protection (per-route)
Most API routes explicitly require a NextAuth session via:
- `requireSession()` from `src/lib/auth/*`

Common pattern in route handlers:
1. `const session = await requireSession()`
2. If `isSessionResponse(session)` → return that response (commonly `401`).
3. Continue with endpoint logic.

---

## 1) Chat — generate an answer (Entry endpoint)

### 1.1 Endpoint
- **`POST /api/chat`**

### Purpose
Generate a chat answer for a user `message` by invoking the chat pipeline. The pipeline supports:
- smalltalk fast-path
- Notion link lookup (by page title)
- SQL/metadata lane
- RAG fallback (hybrid retrieval + streaming LLM)

### Implemented in
- `src/app/api/chat/route.ts`

---

### 1.2 Authentication / Authorization
- **Required**: NextAuth session.
- If session is missing, `requireSession()` returns a `401` JSON response.

### 1.3 Rate limiting
- Implemented in: `src/lib/shared/rate-limit.ts`
- Behavior in this route:
  - `checkRateLimit(userKey)` using `userKey = session.user?.email ?? "anonymous"`.

If rate limited:
- **HTTP**: `429 Too Many Requests`
- JSON:
  ```json
  {
    "error": "Too many requests. Please try again in <seconds> seconds.",
    "retryAfter": <seconds>
  }
  ```
- Header: `Retry-After: <seconds>`

---

### 1.4 Request
- **Method**: `POST`
- **Body (JSON)**: `ChatRequestBody`

Inferred from pipeline usage in `src/lib/chat/*`:
```ts
{
  message?: unknown;   // must be a non-empty string
  history?: unknown;   // chat history items; sanitized internally
  sessionId?: unknown; // optional; when provided must belong to the user
}
```

Key validation behaviors (as used by the pipeline/handler):
- `message` must be a **non-empty string**.
- If `sessionId` is provided:
  - must belong to the authenticated user.

### Headers
- None explicitly required by this route.

---

### 1.5 Response
This endpoint may return either:
1. **Smalltalk / fast-path** JSON response
   - `200 OK`
   - `{ answer: string, emotion: "neutral", sessionId: string | null }`
2. **Non-stream** JSON responses for some lanes (e.g., link/metadata answers)
   - `200 OK`
   - `{ answer: string, emotion?: string }`
3. **Streaming** responses (RAG/SQL lanes)
   - Streaming framing is handled by chat helpers under `src/lib/chat/stream-response.ts`.

---

### 1.6 Errors
- `400 Bad Request`
  - invalid request payload / missing or empty `message`
- `401 Unauthorized`
  - missing session (`requireSession()`)
- `404 Not Found`
  - invalid `sessionId` ownership
- `429 Too Many Requests`
  - rate limited by `checkRateLimit`
  - or Gemini quota errors are mapped to `429` (handled in the route catch)
- `500 Internal Server Error`
  - `{ error: "Failed to get response" }`

---

### 1.7 End-to-end flow (start → end)
Implemented in:
- `src/app/api/chat/route.ts`
- `src/lib/chat/handler.ts`

1. `requireSession()`
2. If missing session → return `401`
3. `checkRateLimit(userKey)`
4. Parse body: `const body = await req.json()`
5. Delegate: `handleChatPost(session, body, req.signal)`
6. In the pipeline (inside `src/lib/chat/*`):
   - validate + sanitize inputs
   - try fast-path smalltalk
   - run Notion link lookup
   - run SQL metadata lane
   - if needed: run RAG retrieval + stream LLM response
7. Route-level catch:
   - if Gemini quota error → return JSON with `429`
   - else return `{ error: "Failed to get response" }` with `500`

---

## 2) Chats — list sessions

### 2.1 Endpoint
- **`GET /api/chats`**

### Purpose
Return chat sessions belonging to the authenticated user.

### Implemented in
- `src/app/api/chats/route.ts` (GET export)

---

### 2.2 Authentication
- Required: NextAuth session.

---

### 2.3 Request
- `GET`
- No body.

---

### 2.4 Response
- `200 OK`
- JSON:
  - `{ sessions }`

Session item shape comes from `src/lib/chat/store.ts` (ChatSessionRow):
```ts
{
  id: string,
  title: string,
  created_at: string,
  updated_at: string
}
```

---

### 2.5 Errors
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 2.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. `listChatSessions(user.id)`
4. Return `{ sessions }`

---

## 3) Chats — create (or return empty)

### 3.1 Endpoint
- **`POST /api/chats`**

### Purpose
Create a new chat session, or return an existing empty chat session for the user.

### Implemented in
- `src/app/api/chats/route.ts` (POST export)

---

### 3.2 Authentication
- Required: NextAuth session.

---

### 3.3 Request
- `POST`
- No body.

---

### 3.4 Response
- `200 OK`

Case A: existing empty chat exists
```json
{ "session": { ... } }
```

Case B: no empty chat exists
```json
{ "session": { ... } }
```

Session item shape: `ChatSessionRow` (same as in Section 2).

---

### 3.5 Errors
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 3.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. `getEmptyChatSession(user.id)`
4. If found → return it
5. Else → `createChatSession(user.id)`
6. Return `{ session: chat }`

---

## 4) Chats — delete a session

### 4.1 Endpoint
- **`DELETE /api/chats/[sessionId]`**

### Purpose
Delete a chat session if it belongs to the authenticated user.

### Implemented in
- `src/app/api/chats/[sessionId]/route.ts` (DELETE export)

---

### 4.2 Authentication
- Required: NextAuth session.

---

### 4.3 Request
- `DELETE`
- URL param:
  - `sessionId: string`

---

### 4.4 Response
- `200 OK`
  - `{ ok: true }`

---

### 4.5 Errors
- `404 Not Found`
  - `{ error: "Chat not found" }`
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 4.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. `ensureSessionBelongsToUser(sessionId, user.id)`
4. If not owned → `404`
5. `deleteChatSession(sessionId, user.id)`
6. If not deleted → `404`
7. Return `{ ok: true }`

---

## 5) Chat Messages — list messages in a session

### 5.1 Endpoint
- **`GET /api/chats/[sessionId]/messages`**

### Purpose
Return message history for a chat session.

### Implemented in
- `src/app/api/chats/[sessionId]/messages/route.ts` (GET export)

---

### 5.2 Authentication / Authorization
- Required: NextAuth session.
- Ownership enforced via `ensureSessionBelongsToUser(sessionId, user.id)`.

If session does not belong to user:
- `404 Not Found`
- `{ error: "Chat not found" }`

---

### 5.3 Request
- `GET`
- URL param:
  - `sessionId`

---

### 5.4 Response
- `200 OK`
- JSON:
  - `{ messages }`

Message item shape: `ChatMessageRow` from `src/lib/chat/store.ts`:
```ts
{
  id: string,
  session_id: string,
  role: "user" | "bot",
  content: string,
  emotion?: string,
  created_at: string
}
```

Messages are limited by `CHAT_HISTORY_LIMIT` (used as the limit argument).

---

### 5.5 Errors
- `404 Not Found`
  - `{ error: "Chat not found" }`
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 5.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. `ensureSessionBelongsToUser(sessionId, user.id)`
4. `listChatMessages(sessionId, CHAT_HISTORY_LIMIT)`
5. Return `{ messages }`

---

## 6) Chat Messages — add a message

### 6.1 Endpoint
- **`POST /api/chats/[sessionId]/messages`**

### Purpose
Persist a user/bot message into an existing chat session.

### Implemented in
- `src/app/api/chats/[sessionId]/messages/route.ts` (POST export)

---

### 6.2 Authentication / Authorization
- Required: NextAuth session.
- Ownership enforced via `ensureSessionBelongsToUser(sessionId, user.id)`.

If not owned:
- `404`
- `{ error: "Chat not found" }`

---

### 6.3 Request
- `POST`
- URL param:
  - `sessionId`
- Body (JSON):
  ```json
  {
    "role": "user" | "bot",
    "content": "string"
  }
  ```

Validation (route-level):
- `role` must be exactly `user` or `bot`
- `content` must be a string and must be non-empty after `trim()`

---

### 6.4 Response
- `200 OK`
  - `{ message: <ChatMessageRow> }`

---

### 6.5 Errors
- `400 Bad Request`
  - `{ error: "Invalid message" }`
- `404 Not Found`
  - `{ error: "Chat not found" }`
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 6.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. Ownership check: `ensureSessionBelongsToUser(sessionId, user.id)`
4. Parse body: `const { role, content } = await req.json()`
5. Validate role + content
6. Persist: `addChatMessage(sessionId, role, content.trim())`
7. Return `{ message }`

---

## 7) Chat Messages — delete/clear messages

### 7.1 Endpoint
- **`DELETE /api/chats/[sessionId]/messages`**

### Purpose
Delete messages in a session.

Behavior:
- If query param `messageId` is provided → delete messages starting from that message (by `created_at` within session) via `deleteMessagesFrom(...)`.
- If `messageId` is omitted → clear all messages in session via `clearChatMessages(...)`.

### Implemented in
- `src/app/api/chats/[sessionId]/messages/route.ts` (DELETE export)

---

### 7.2 Authentication / Authorization
- Required: NextAuth session.
- Ownership enforced via `ensureSessionBelongsToUser(...)`.

If not owned:
- `404`
- `{ error: "Chat not found" }`

---

### 7.3 Request
- `DELETE`
- URL param:
  - `sessionId`
- Optional query parameter:
  - `messageId=<id>`

---

### 7.4 Response
- `200 OK`
  - `{ ok: true }`

---

### 7.5 Errors
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 7.6 End-to-end flow
1. `requireSession()`
2. `getOrCreateUser(session)`
3. Ownership check
4. Parse `messageId` from URL search params
5. If present → `deleteMessagesFrom(sessionId, messageId)`
6. Else → `clearChatMessages(sessionId)`
7. Return `{ ok: true }`

---

## 8) Sync — get last sync time

### 8.1 Endpoint
- **`GET /api/sync`**

### Purpose
Return the last time the Notion knowledge base was synced into Postgres.

### Implemented in
- `src/app/api/sync/route.ts` (GET export)

---

### 8.2 Authentication
- Required: NextAuth session.

---

### 8.3 Request
- `GET`
- No body.

---

### 8.4 Response
- `200 OK`
- JSON:
  ```json
  { "synced_at": "string | null" }
  ```

How it is computed:
1. `getNotionLastSyncRun()` (preferred)
2. If missing, fallback query:
   - `SELECT MAX(synced_at)::text AS last_synced_at FROM notion_pages`

---

### 8.5 Errors
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 8.6 End-to-end flow
1. `requireSession()`
2. `getNotionLastSyncRun()`
3. If null → DB fallback
4. Return `{ synced_at }`

---

## 9) Sync — trigger rebuild/sync

### 9.1 Endpoint
- **`POST /api/sync`**

### Purpose
Trigger rebuild/sync of the knowledge base from Notion into Postgres.

### Implemented in
- `src/app/api/sync/route.ts` (POST export)

---

### 9.2 Authentication + authorization
- Required: NextAuth session.
- Additional authorization via:
  - `hasKnowledgeBaseAccess(session)` from `src/lib/shared/access.ts`

Current rule (as enforced here):
- Only user with email `tamanna@navgurukul.org` can sync/rebuild.
- If forbidden:
  - `403 Forbidden`
  - JSON:
    ```json
    {
      "error": "Forbidden: only tamanna@navgurukul.org can sync or rebuild the knowledge base."
    }
    ```

---

### 9.3 Rate limiting (sync-specific)
Uses route-local `createRateLimiter({ maxRequests: 1, windowMs: 2*60_000 })`.

- If rate limited:
  - `429 Too Many Requests`
  - JSON:
    ```json
    {
      "error": "Too many sync requests. Wait a couple of minutes before trying again."
    }
    ```

Rate key:
- `userKey = session.user?.email?.toLowerCase() || "anonymous"`

---

### 9.4 Request
- `POST`
- No body.
- Query parameters read from URL:
  - `force=true|false` (default `false`)
  - `embed=true|false` (default `false`)
    - only applied if `process.env.EMBEDDINGS_ENABLED !== "false"`
  - `refreshContent=true|false` (default `false`)

---

### 9.5 Response
- `200 OK`
- JSON:
  ```json
  {
    "message": "Sync complete",
    ...result
  }
  ```

`result` is returned from `syncNotionToPostgres({ force, embed, refreshContent })`.

---

### 9.6 Errors
- `403 Forbidden` (access denied)
- `429 Too Many Requests` (sync rate limit)
- `500 Internal Server Error`
  - `{ error: "<message>" }`

---

### 9.7 End-to-end flow
1. `requireSession()`
2. `hasKnowledgeBaseAccess(session)` else `403`
3. Rate limit check for sync
4. Parse URL query params: `force`, `embed`, `refreshContent`
5. Call `syncNotionToPostgres({ force, embed, refreshContent })`
6. Return `{ message: "Sync complete", ...result }`

---

## 10) Cost report — historical LLM usage estimate

### 10.1 Endpoint
- **`GET /api/cosr-report/llm-usage`**

### Purpose
Return an aggregated and estimated LLM usage/cost report based on stored chat message text.

### Implemented in
- `src/app/api/cosr-report/llm-usage/route.ts`

---

### 10.2 Authentication
- Required: NextAuth session.

---

### 10.3 Request
- `GET`
- No body.

---

### 10.4 Response
- `200 OK`
- JSON:
  ```ts
  {
    modelId: string,
    totals: {
      inputTokensEst: number,
      outputTokensEst: number,
      totalTokensEst: number,
      inputUsdEst: number,
      outputUsdEst: number,
      totalUsdEst: number,
      totalUserMessages: number,
      totalBotMessages: number
    },
    users: Array<{
      userId: string,
      email: string,
      name: string | null,
      totalUserMessages: number,
      totalBotMessages: number,
      inputTokensEst: number,
      outputTokensEst: number,
      totalTokensEst: number,
      inputUsdEst: number,
      outputUsdEst: number,
      totalUsdEst: number
    }>
  }
  ```

Model pricing selection:
- `modelId = NEXT_PUBLIC_COST_REPORT_MODEL_ID || OPENAI_CHAT_MODEL || "gpt-4o-mini"`

Token heuristic:
- token ≈ `chars / 4` (implemented as `CEIL(LENGTH(cm.content) / 4.0)`)

Pricing:
- uses `CHAT_PRICES` from `src/app/cost-report/AwsComputeCost.ts`
- if pricing is missing, USD fields become `0`.

Aggregation approach:
- Joins:
  - `users` → `chat_sessions` → `chat_messages`
- Counts:
  - user messages vs bot messages
- Sums:
  - estimated input/output tokens by message role
- Returns:
  - top users by total token usage (limit 50)

---

### 10.5 Errors
- `500 Internal Server Error`
  - `{ error: "Failed to fetch LLM usage" }`

---

### 10.6 End-to-end flow
1. `requireSession()`
2. Determine `modelId` from env
3. Execute aggregation SQL across users/sessions/messages
4. Compute totals and return JSON

---

## 11) Route inventory summary

All implemented API routes under `src/app/api/*`:

1. **Auth**
   - `GET    /api/auth/*`
   - `POST   /api/auth/*`

2. **Chat**
   - `POST   /api/chat`

3. **Chats (sessions)**
   - `GET    /api/chats`
   - `POST   /api/chats`
   - `DELETE /api/chats/[sessionId]`

4. **Chat messages (per session)**
   - `GET    /api/chats/[sessionId]/messages`
   - `POST   /api/chats/[sessionId]/messages`
   - `DELETE /api/chats/[sessionId]/messages?messageId=<id>`
   - `DELETE /api/chats/[sessionId]/messages` (clear all)

5. **Sync**
   - `GET    /api/sync`
   - `POST   /api/sync?force=...&embed=...&refreshContent=...`

6. **Cost report**
   - `GET /api/cosr-report/llm-usage`

