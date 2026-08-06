import { normalizeEmail, type SessionEmailLike } from "./access";

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? "navgurukul.org";

export function hasNavgurukulDomainAccess(session: SessionEmailLike) {
  const email = normalizeEmail(session?.user?.email);
  if (!email) return false;
  return email.endsWith(`@${ALLOWED_DOMAIN}`);
}

