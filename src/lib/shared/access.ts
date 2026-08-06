export const KNOWLEDGE_BASE_MANAGER_EMAILS = new Set([
  "laxmiyadav21@navgurukul.org",
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