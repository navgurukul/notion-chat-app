# TODO - Notion Chat App Access Control

## Step 1: Enforce @navgurukul.org during login
- [x] Update `src/app/login/page.tsx` to validate email domain after authentication and before redirecting to `/`.
- [x] Add a UI/guard so unauthorized users can’t continue (no redirect + show forbidden message).


## Step 2: Enforce @navgurukul.org on ALL API routes
- [ ] Add centralized API middleware/helper to check domain using `hasNavgurukulDomainAccess`.
- [ ] Apply it to all routes under `src/app/api/*` (chat, chats, messages, sync, etc.).

## Step 3: Verify with lint/build
- [ ] Ensure `npm run lint` passes (currently repo has existing lint errors; access control changes must not add new ones).
- [ ] Run `npm run build` and manually test login + API calls with a non-allowed Google account.

