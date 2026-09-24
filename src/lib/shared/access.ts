export const KNOWLEDGE_BASE_MANAGER_EMAILS = new Set([
  "tamanna@navgurukul.org",
]);

export type SessionEmailLike = {
  user?: {
    email?: string | null;
  } | null;
} | null | undefined;

export function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

export function hasKnowledgeBaseAccess(session: SessionEmailLike) {
  return KNOWLEDGE_BASE_MANAGER_EMAILS.has(normalizeEmail(session?.user?.email));
}