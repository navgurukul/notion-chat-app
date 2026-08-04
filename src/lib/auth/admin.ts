// Add/remove emails here to control access
export const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "tamanna@navgurukul.org",
  // add more as needed
]);

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase().trim());
}