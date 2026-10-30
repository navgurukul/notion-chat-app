import { KNOWLEDGE_BASE_MANAGER_EMAILS } from "@/lib/shared/access";

// Add/remove emails here to control access
export const ADMIN_EMAILS: ReadonlySet<string> = KNOWLEDGE_BASE_MANAGER_EMAILS;

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase().trim());
}