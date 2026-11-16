# Chat sharing

- **Who can open a link:** Any signed-in NG user who has the link can view it. Everyone else sees “This shared chat is not available.”
- **What is shared:** A read-only snapshot of the chat title and each message’s role, content, and time. The share stores a token hash, not the raw link token. It does not share or store account details, email, or other chat/session data in the snapshot.
- **Lifecycle:** Each chat has one active link. The full link is shown only when first created (or reshared); save it then. Resharing creates a new link and disables the old one. Stop sharing revokes the active link. Deleting the chat removes its share links and snapshots.
- **Routes:** `GET`, `POST`, and `DELETE /api/chats/{sessionId}/share` check status, create/reshare, and stop sharing. `GET /api/shared/{token}` returns the shared snapshot. The read-only page is `/shared/{token}`.
- **Tables and schema:** `chat_shares` stores share records and token hashes; `shared_chat_messages` stores snapshot messages. If these tables or their schema change, bump `CURRENT_SCHEMA_HASH` in `src/lib/db/postgres.ts` from `v11_chat_shares` to a new value so schema setup runs again.
- **Automated check:** Run `npm run test:chat-share` with the app’s database environment configured. The check uses and removes test rows. The test file exists at `scripts/test-chat-share.ts`, but this command is not currently registered in `package.json`.
- **Manual check:** Create a link and open it in a signed-in NG account; confirm title, roles, content, and times. Try signed out and with a non-NG account; both should see unavailable. Reshare and confirm the old link fails and the new one works; stop sharing and confirm the active link fails; delete a test chat and confirm its links no longer work.
- **Not built yet:** Link expiry, per-person access, and rate limiting.
