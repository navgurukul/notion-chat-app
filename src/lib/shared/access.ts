export const KNOWLEDGE_BASE_MANAGER_EMAIL = "tamanna@navgurukul.org";

export type SessionEmailLike = {
  user?: {
    email?: string | null;
  } | null;
} | null | undefined;

export function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

export function hasKnowledgeBaseAccess(session: SessionEmailLike) {
  return normalizeEmail(session?.user?.email) === KNOWLEDGE_BASE_MANAGER_EMAIL;
}