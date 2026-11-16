import { query } from "@/lib/db/postgres";
import { hashShareToken } from "./share-token";

export type SharedChatMessage = {
  role: string;
  content: string;
  createdAt: string;
};

export type SharedChat = {
  title: string;
  messages: SharedChatMessage[];
};

export async function getSharedChatByToken(token: string): Promise<SharedChat | null> {
  const rows = await query<{
    title: string;
    role: string | null;
    content: string | null;
    createdAt: string | null;
  }>(
    `SELECT cs.title, scm.role, scm.content,
            to_char(scm.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
     FROM chat_shares share
     JOIN chat_sessions cs ON cs.id = share.session_id
     LEFT JOIN shared_chat_messages scm ON scm.share_id = share.id
     WHERE share.token_hash = $1 AND share.revoked_at IS NULL
     ORDER BY scm.created_at ASC`,
    [hashShareToken(token)],
  );

  if (rows.length === 0) return null;

  return {
    title: rows[0].title,
    messages: rows
      .filter((row): row is typeof row & { role: string; content: string; createdAt: string } =>
        row.role !== null && row.content !== null && row.createdAt !== null,
      )
      .map(({ role, content, createdAt }) => ({ role, content, createdAt })),
  };
}
