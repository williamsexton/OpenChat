# Contracts Changelog

## 2026-07-28 — Native-auth consolidation (single standard for non-browser clients)
- **[STANDARD]** All non-browser clients (desktop + mobile) now authenticate the same way:
  **OAuth Authorization-Code + PKCE → `POST /auth/oauth/token`**, yielding a short-lived
  access JWT + rotating refresh family (`TokenService`). The browser is unchanged (session
  cookie); the composite `AuthGuard` keeps bearer-OR-cookie working.
- **[CHANGE] Desktop client (0.8.3) switched to PKCE.** `/auth/desktop` is now opened with
  `?code_challenge=<S256>&code_challenge_method=S256`; the client exchanges the returned
  `openchat://auth?code=…` for a token family and refreshes on 401 (single-flight rotation).
- **[DEPRECATED] `/auth/desktop` without a `code_challenge`** — the legacy branch that minted a
  long-lived opaque app token and deep-linked `?token=…`. Kept only for desktop clients < 0.8.3;
  remove once old installs have updated.
- **[CLARIFY] `GET/POST/DELETE /auth/tokens`** are now positioned as **personal access tokens**
  (scripts/bots/API), NOT the native sign-in mechanism. Behavior unchanged.
- **[FIX] `AuthGuard` now validates legacy `oc_…` app tokens (and `?token=` media auth).**
  P1-02's guard replaced `SessionGuard` but only accepted JWT-or-cookie, so it silently rejected
  the `oc_` app tokens `SessionGuard` had honored — 401-ing every request from installed desktop
  clients (< 0.8.3) and PATs. `AuthGuard` is now a genuine superset: JWT → legacy `oc_` app token
  → session cookie.

## 2026-07-21 — P0-10 shape corrections (three routes)

- **[CHANGE] `GET /config` — removed `security: []`.** Server response is 401 without session cookie (`@UseGuards(SessionGuard)` in `config.controller.ts:6`). Contract now matches observed behavior. Evidence: `provider.spec.ts:433` "GET /config → 200 (requires auth — characterized)", live `curl` returning 401. Pre-auth public subset (`GET /config/public`) deferred to Phase 1 per DR-002.
- **[CHANGE] `GET /friends/requests` — response shape corrected from bare array to `{incoming, outgoing}`.** Server returns an object with two array fields, not a bare array. Evidence: `provider.spec.ts:395-402` asserting `.toHaveProperty('incoming')` and `.toHaveProperty('outgoing')`, 36/36 contract suite passing with `additionalProperties:false`.
- **[CHANGE] `GET /notifications` — response shape corrected from bare array to `{friendRequests, serverInvites, count}`.** Server returns an object with `friendRequests` array, `serverInvites` array, and `count` integer. Evidence: `provider.spec.ts:406-413` asserting all three fields, 36/36 contract suite passing with `additionalProperties:false`.

All three corrections are server-observed; server behavior beats aspirational contract. The ajv suite (36/36 with `additionalProperties:false`) confirms the corrected shapes are exact.

## 2026-07-21 — P0-06 confirmations (pre-P0-07)
- [CHANGE] `POST server-invitations/:id/accept` — corrected from `/notifications/server-invitations/:id/accept` in 03-CONTRACTS.md §2. The NotificationsController uses `@Controller()` with no prefix, so the route is `/api/server-invitations/:id/accept`, not under `/notifications/`. Evidence: `apps/api/src/notifications/notifications.controller.ts:21`, capability `invites.spec.ts#notif-accept`.
- [CHANGE] `POST server-invitations/:id/decline` — same correction. Evidence: `apps/api/src/notifications/notifications.controller.ts:26`, capability `invites.spec.ts#notif-decline`.
## P1-01/02/03 (2026-07-24, amended 2026-07-27)
- `POST /auth/oauth/token` added — authorization_code + refresh_token grants, rotation
  with family revocation on reuse (x-added-by P1-01).
  **(2026-07-27: renamed from `/auth/token` to `/auth/oauth/token` to disambiguate
  from the existing `/auth/tokens` plural route.)**
- `GET /auth/oidc-metadata` added — public native-client metadata, no secrets
  (x-added-by P1-03, per DR-002 option D).
- `bearerAuth` security scheme added; every guarded route now accepts bearer OR
  cookie (composite AuthGuard, P1-02). Cookie behavior unchanged.
- `POST /auth/dev-login` response extended with accessToken/refreshToken/expiresIn
  when DEV_AUTH=1 (intentional characterization change, P1-02).

## P2 ground-truth correction (2026-07-25)
- `subscribe`/`unsubscribe`: `d.channelId` (singular, one frame per channel) —
  NOT `channelIds[]` as previously recorded.
- `message.created`: `d: {message, nonce?}` (relay wraps; echo adds nonce) —
  NOT a bare Message. Verified against events.gateway.ts and live probe.
