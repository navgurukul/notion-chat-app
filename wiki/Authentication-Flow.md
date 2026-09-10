# Authentication & Authorization Flow (NextAuth + Route Guards)

This app uses **NextAuth** for authentication and enforces authorization using:
- NextAuth sign-in callback gating (allowed email domain)
- UI protection via `src/app/middleware.ts`
- API protection via per-route `requireSession()` checks

---

## 1) “Authentication API” (NextAuth endpoints)

### Endpoint
- **`/api/auth/*`**
- Implemented in: `src/app/api/auth/[...nextauth]/route.ts`

### What it does
This route exports the NextAuth handler as both **`GET`** and **`POST`**. NextAuth uses it to handle:
- OAuth sign-in initiation
- OAuth callback processing
- session/token management

---

## 2) Sign-in configuration and domain gate

Implemented in: `src/lib/auth/options.ts`

### Provider
- **GoogleProvider**

### Allowed domain enforcement
During sign-in, NextAuth calls:
- `callbacks.signIn({ user })`

The callback returns the result of:
- `hasNavgurukulDomainAccess({ user: { email: user?.email ?? undefined } })`

So login is blocked early for users outside the allowed domain.

---

## 3) Domain access rule

Implemented in: `src/lib/shared/navgurukul-domain.ts`

### Logic
- Allowed domain is read from `process.env.ALLOWED_EMAIL_DOMAIN`
- Default: `navgurukul.org`
- The check is:
  - `email.endsWith(@<allowed-domain>)`

---

## 4) UI / page protection (middleware)

Implemented in: `src/app/middleware.ts`

### When it runs
The middleware matcher excludes:
- `/login`
- `api/auth` (NextAuth)
- static assets like `/_next/static`, `/_next/image`
- `favicon.ico`

### Behavior
1. Fetches session:
   - `getServerSession(authOptions)`
2. If no session:
   - **redirects** to `/login`
3. If session exists:
   - checks domain via `hasNavgurukulDomainAccess`
   - if forbidden:
     - returns `403` JSON
4. Otherwise:
   - calls `NextResponse.next()` to allow the request

---

## 5) API protection (per-route session checks)

### Common helper
Implemented in: `src/lib/auth/session.ts`

#### `requireSession()`
- Calls `getServerSession(authOptions)`
- If missing:
  - returns `NextResponse.json({ error: "Unauthorized" }, { status: 401 })`
- If present:
  - returns the NextAuth `Session`

### Example: `POST /api/chat`
Implemented in: `src/app/api/chat/route.ts`

Auth/flow snippet:
1. `const session = await requireSession();`
2. If `session` is a response object (`isSessionResponse(session)`):
   - return it (typically `401`)
3. Continue with:
   - rate limiting
   - `handleChatPost(session, body, req.signal)`

---

## 6) End-to-end summary

1. User visits `/login` and performs Google OAuth.
2. NextAuth processes the sign-in callback.
3. `callbacks.signIn` applies the allowed-domain gate.
4. After successful login, NextAuth establishes a session.
5. `src/app/middleware.ts` protects UI routes:
   - redirects to `/login` if missing session
   - returns `403` if outside allowed email domain
6. API routes protect themselves by calling `requireSession()`.

---

## 7) Key files (quick index)
- **NextAuth handlers:** `src/app/api/auth/[...nextauth]/route.ts`
- **NextAuth options + sign-in gate:** `src/lib/auth/options.ts`
- **Session guard:** `src/lib/auth/session.ts`
- **Domain rule:** `src/lib/shared/navgurukul-domain.ts`
- **UI middleware:** `src/app/middleware.ts`
- **Protected API example:** `src/app/api/chat/route.ts`

