# ADR-0007: Opaque database sessions instead of JWT, and how Entra ID would plug in

- **Status:** Accepted (Phase 1, 2026-10-14). Entra ID is design text only; no code in the POC.
- **Decision ids:** D-05, D-06, D-07 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [04 §2](../design/04-security-and-api.md#2-authentication)

## Context

§6: every route requires a real, authenticated user. The app reads PostgreSQL on every request anyway, roles change (an approver demoted to finance, a leaver deactivated), and logout must mean logout. The learning path also covers JWT and Entra ID concepts. Options weighed: self-issued JWT sessions (no revocation without a denylist, which is a DB lookup again), Auth.js v5 (its credentials provider forces JWT sessions), Better Auth (a larger surface than the POC needs), and hand-rolled opaque sessions (about 150 explainable lines).

## Decision

**Opaque sessions in Postgres** (`src/server/auth/session.ts`):

- Login (`POST /api/v1/auth/login`, public) verifies an argon2id hash from `node:crypto` (`src/server/auth/password.ts`). Wrong password and unknown email give the same 401 `INVALID_CREDENTIALS`. Login deletes any session the request presented and issues a new one.
- The token is 32 random bytes in an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie: `ec_session` on http localhost, `__Host-ec_session` (Secure) on https. Only `sha256(token)` is stored.
- 60-minute sliding idle timeout (touched at most every 5 minutes) and a 12-hour absolute limit.
- `actorForToken()` loads the session and the live `users` row on every request, so role and `can_approve` are always current, and deactivation or logout takes effect on the next request.
- `defineRoute` authenticates inside every handler. `proxy.ts` only redirects page requests that lack a cookie; CVE-2025-29927 showed middleware can be skipped.
- CSRF: `SameSite=Lax`, plus an Origin / `Sec-Fetch-Site` check on unsafe methods and on the export GET (403 `CSRF_REJECTED`), JSON-only bodies (415), no CORS. No `AUTH_SECRET` exists.

**Entra ID mapping (production design):**

1. `GET /api/v1/auth/entra/login` (public) stores state, nonce and a PKCE verifier in a short-lived `__Host-` cookie and redirects to Entra.
2. `GET /api/v1/auth/entra/callback` (public) runs the authorization-code grant and validates `iss`, `aud`, `tid`, `exp` and `nonce`.
3. The user is found by `(tid, oid)`, **never by email** (mutable and not guaranteed verified). A migration adds that unique pair to `users`.
4. Then the same `createSession(user.id)`: identical cookie and `Actor` from here on.

Entra App Roles and the manager hierarchy (Graph `/users/{id}/manager`) are synced into `users.role`, `can_approve` and `manager_id` by an owner-role job; `expense_app` still cannot write them. Production disables password login, and the client credential is a certificate or federated credential through managed identity, never a secret in env. Machine clients would add a second resolver in `authenticate()` that validates an Entra-issued JWT bearer against the tenant JWKS (issuer, audience, `scp`) and maps `oid` to the same `Actor`. That is where JWT belongs here: we validate tokens from an identity provider, while our own browser session stays opaque and revocable.

## Consequences

- Revocation is instant and roles are never stale; the cost is one indexed lookup per request, which we pay anyway.
- Authorization only ever sees an `Actor`, so changing how people prove who they are never touches who can do what.
- No sign-up, password reset or MFA in the POC: users are seeded; production identity comes from Entra.
- Login throttling is optional and not built.

## Evidence

- TC-I02 (`tests/integration/auth/login.int.test.ts`) › "login sets an HttpOnly SameSite=Lax session cookie (Secure and __Host- prefix on https)", "wrong password and unknown email return identical 401 INVALID_CREDENTIALS", "logout deletes the session and the old cookie gets 401", "idle and absolute expiry are enforced", "deactivating a user revokes their sessions on the next request", "a role change takes effect on the next request", "login issues a new token and deletes any presented session".
- TC-I03 › "POST with a cross-site Origin returns 403 CSRF_REJECTED", "JSON routes reject non-JSON content types with 415", "export GET with Sec-Fetch-Site: cross-site returns 403 CSRF_REJECTED".
- TC-I01 › "every non-public route returns 401 UNAUTHENTICATED with an expired session", "the x-middleware-subrequest header does not bypass authentication".
- Files: `src/server/auth/{session,password,cookie,actor}.ts`, `src/server/http/csrf.ts`, `src/proxy.ts`.
