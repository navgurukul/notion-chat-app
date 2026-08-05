import type { Session } from "next-auth";
import { query } from "@/lib/db/postgres";

export const CHAT_HISTORY_LIMIT = 30;

export type ChatSessionRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ChatMessageRow = {
  id: string;
  session_id: string;
  role: "user" | "bot";
  content: string;
  emotion?: string;
  created_at: string;
};

type UserRow = {
  id: string;
};

function requireUserEmail(session: Session | null) {
  const email = session?.user?.email?.trim();
  if (!email) throw new Error("Authenticated user email is required");
  return email;
}

function buildSessionTitle(message: string) {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Chat";
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}...` : cleaned;
}

const globalForUserCache = globalThis as unknown as {
  userCache: Map<string, string> | undefined;
};

const userCache = globalForUserCache.userCache ?? new Map<string, string>();

if (process.env.NODE_ENV !== "production") {
  globalForUserCache.userCache = userCache;
}

export async function getOrCreateUser(session: Session | null) {
  const email = requireUserEmail(session);

  const cachedId = userCache.get(email);
  if (cachedId) {
    return { id: cachedId };
  }

  // 1. Try a fast SELECT first to avoid write transactions
  const existing = await query<UserRow>(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );
  if (existing.length > 0) {
    const userId = existing[0].id;
    userCache.set(email, userId);
    return { id: userId };
  }

  // 2. Otherwise insert/create user
  const rows = await query<UserRow>(
    `
    INSERT INTO users (email, name, image_url, provider, last_login_at, updated_at)
    VALUES ($1, $2, $3, 'google', now(), now())
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name,
      image_url = EXCLUDED.image_url,
      last_login_at = now(),
      updated_at = now()
    RETURNING id
    `,
    [email, session?.user?.name ?? null, session?.user?.image ?? null],
  );

  const user = rows[0];
  if (user) {
    userCache.set(email, user.id);
  }
  return user;
}

export async function listChatSessions(userId: string) {
  return query<ChatSessionRow>(
    `
    SELECT id, title, created_at::text, updated_at::text
    FROM chat_sessions
    WHERE user_id = $1
    ORDER BY updated_at DESC
    LIMIT 50
    `,
    [userId],
  );
}

export async function createChatSession(userId: string, title = "New Chat") {
  const rows = await query<ChatSessionRow>(
    `
    INSERT INTO chat_sessions (user_id, title)
    VALUES ($1, $2)
    RETURNING id, title, created_at::text, updated_at::text
    `,
    [userId, title],
  );
  return rows[0];
}

export async function ensureSessionBelongsToUser(sessionId: string, userId: string) {
  const rows = await query<{ id: string }>(
    `
    SELECT id
    FROM chat_sessions
    WHERE id = $1 AND user_id = $2
    LIMIT 1
    `,
    [sessionId, userId],
  );
  return Boolean(rows.length);
}

export async function listChatMessages(sessionId: string, limit = CHAT_HISTORY_LIMIT) {
  return query<ChatMessageRow>(
    `
    SELECT id, session_id, role, content, emotion, created_at::text
    FROM (
      SELECT id, session_id, role, content, emotion, created_at
      FROM chat_messages
      WHERE session_id = $1
      ORDER BY created_at DESC, role ASC
      LIMIT $2
    ) recent
    ORDER BY created_at ASC, role DESC
    `,
    [sessionId, limit],
  );
}

export async function addChatMessage(sessionId: string, role: "user" | "bot", content: string, emotion?: string) {
  const rows = await query<ChatMessageRow>(
    `
    INSERT INTO chat_messages (session_id, role, content, emotion)
    VALUES ($1, $2, $3, $4)
    RETURNING id, session_id, role, content, emotion, created_at::text
    `,
    [sessionId, role, content, emotion ?? null],
  );

  if (role === "user") {
    await query(
      `
      UPDATE chat_sessions
      SET
        title = CASE WHEN title = 'New Chat' THEN $2 ELSE title END,
        updated_at = now()
      WHERE id = $1
      `,
      [sessionId, buildSessionTitle(content)],
    );
  } else {
    await query("UPDATE chat_sessions SET updated_at = now() WHERE id = $1", [sessionId]);
  }

  return rows[0];
}

export async function clearChatMessages(sessionId: string) {
  await query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
  await query(
    "UPDATE chat_sessions SET title = 'New Chat', updated_at = now() WHERE id = $1",
    [sessionId],
  );
}

export async function deleteChatSession(sessionId: string, userId: string) {
  const rows = await query<{ id: string }>(
    `
    DELETE FROM chat_sessions
    WHERE id = $1 AND user_id = $2
    RETURNING id
    `,
    [sessionId, userId],
  );
  return rows.length > 0;
}

export async function deleteMessagesFrom(sessionId: string, messageId: string) {
  await query(
    `
    DELETE FROM chat_messages
    WHERE session_id = $1
      AND created_at >= (
        SELECT created_at
        FROM chat_messages
        WHERE id = $2 AND session_id = $1
      )
    `,
    [sessionId, messageId],
  );
  await query(
    `
    UPDATE chat_sessions
    SET updated_at = now()
    WHERE id = $1
    `,
    [sessionId],
  );
}

export async function getEmptyChatSession(userId: string) {
  const rows = await query<ChatSessionRow>(
    `
    SELECT
      cs.id,
      cs.title,
      cs.created_at::text,
      cs.updated_at::text
    FROM chat_sessions cs
    LEFT JOIN chat_messages cm
      ON cm.session_id = cs.id
    WHERE cs.user_id = $1
    GROUP BY cs.id
    HAVING COUNT(cm.id) = 0
    ORDER BY cs.updated_at DESC
    LIMIT 1
    `,
    [userId],
  );

  return rows[0] ?? null;
}

export interface ActiveEntity {
  id: string;
  name: string;
  confidence: number;
  source: "rules" | "retrieval" | "llm";
}

export type PendingClarification = {
  type: "person" | "project";
  candidates: string[];
  lastUserQueryPreCorrection: string;
  oldEntityRaw?: string;
};

export type ConversationState = {
  activeProject?: ActiveEntity;
  activePerson?: ActiveEntity;
  lastProject?: string;
  lastPerson?: string;
  lastMale?: string;
  lastFemale?: string;
  lastIntent?: string;
  lastYear?: number;
  lastPage?: string;
  lastRewrittenQuery?: string;
  lastUserQueryPreCorrection?: string;
  pendingClarification?: PendingClarification;
};

export async function getSessionState(sessionId: string): Promise<ConversationState | null> {
  const rows = await query<{ state: ConversationState | null }>(
    "SELECT state FROM chat_sessions WHERE id = $1 LIMIT 1",
    [sessionId],
  );
  return rows[0]?.state ?? null;
}

export async function updateSessionState(sessionId: string, state: ConversationState): Promise<void> {
  await query(
    "UPDATE chat_sessions SET state = $2, updated_at = now() WHERE id = $1",
    [sessionId, JSON.stringify(state)],
  );
}


