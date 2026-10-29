# ADR-0001: One Next.js app, REST-only, and the fallbacks we did not need

- **Status:** Accepted (Phase 0, 2026-10-14). Reviewed with final facts in Phase 8 (2026-10-16).
- **Decision ids:** D-01, D-38, D-41 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Related:** [ADR-0002](0002-layering-and-import-boundaries.md) (layers), [ADR-0008](0008-db-roles-and-migrations-as-a-job.md) (migrate job)

## Context

The POC needs a UI, an API whose rules hold "even via a direct API call" (§3.1, §6), and a stack that starts with `docker compose up` and only a `.env`. The learning path allows Express or Next.js. Options weighed: Express API + Vite SPA (two deployables, two auth set-ups), tRPC (RPC semantics instead of HTTP status codes), Server Actions (implicit public POST endpoints, a second way in).

## Decision

- **One Next.js 16.4 App Router app in one container.** REST Route Handlers under `/api/v1` are the only way in: route → service → repository → PostgreSQL. The finished app exports **29 route handlers**: 22 endpoints plus the `/api/v1/[...path]` catch-all for 7 methods, which answers 401 without a session and 404 `ROUTE_NOT_FOUND` with one.
- **Server Actions, `'use cache'` and `$queryRawUnsafe` are banned by ESLint.** Server Components render only the shell (`getActor()` in `(app)/layout.tsx`); every data read and write goes through `/api/v1` with TanStack Query.
- **Authentication runs inside every handler** (`defineRoute`), not in `proxy.ts`. `PUBLIC_ROUTES` = login + `/api/health/live` + `/api/health/ready`.
- **`output: 'standalone'`, `cacheComponents: false`.** Migrations run in a one-shot `migrate` job built from the same Dockerfile (`tools` target), never in the app entrypoint.

## Consequences

- One door for Vitest (routes called in-process with a real `NextRequest`), curl, Playwright and the browser, so every authorization test exercises the production path.
- Deleting `proxy.ts` would change nothing about API security; it only redirects pages without a cookie.
- The runtime image has no Prisma CLI, no dev dependencies, no `.env` and no DDL rights.
- Cost: every screen is a client component that fetches over HTTP; no Server Component data shortcuts.

## Phase 0 results: fallbacks and Day-1 checks

None of the planned fallbacks (01 §3.4) was needed:

| Risk | Outcome |
|---|---|
| Standalone build with Prisma 7 ESM + pnpm | Works as planned. `.next/standalone` contains the Prisma query compiler; no `nodeLinker: hoisted`, no `--webpack`. |
| ESM imports under `tsx` | Work with `"type": "module"`. One gotcha: import `@next/env` as a default import under `tsx` (`import nextEnv from '@next/env'`). |
| TypeScript 6.0.3, Vitest 5.0.3 | Both work; no downgrade. |
| Prisma 7.10 + `PrismaPg` query events | Emitted with `log: [{ emit: 'event', level: 'query' }]` (TC-I17 captures the SQL it sends; `perf:explain` reuses it). |
| Testcontainers 12.2 | Works with the roles script mounted; `postgres:18.6-trixie` pinned by digest, same as compose. |
| Migration drift | `db:deploy` + `db:diff-check` → "No difference detected"; `migrate dev --create-only` twice → empty migrations. |

Later gates: the **P6 storage gate passed**, so SeaweedFS 4.48 (`weed mini`, digest-pinned) stays and the filesystem fallback exists only as an adapter (`FsReceiptStorage`). **Plan B for the total** (compute-on-read) was not triggered ([ADR-0003](0003-claim-total-integrity.md)).

Deviations from the design docs, all small: Tailwind 4 uses the 16.4 template's `@tailwindcss/turbopack` loader (no `postcss.config.mjs`); the ESLint pages zone is a regex, because a gitignore-style `!@/server/auth/rsc` can't re-include a file under an excluded folder; the Postgres healthcheck probes TCP (`pg_isready -h 127.0.0.1`), because during initdb the server listens only on its socket; `tests/helpers/global-setup.ts` can also use an existing PostgreSQL via `TEST_PG_SUPERUSER_URL`.

Still open: `next` is pinned at 16.4.0 because no newer 16.4.x patch had been published when checked; re-check before a release (fallback: the patched 16.3.x line). `prisma migrate reset` has not been exercised (Prisma 7.10 refuses it under an AI agent without the user's consent); the privileges migration re-asserts the schema grants that a reset drops, and TC-I07 checks the full matrix after every deploy.

## Evidence

- TC-I01 (`tests/integration/auth/every-route-requires-auth.int.test.ts`) › "every exported handler for every HTTP method carries ROUTE_META", "only PUBLIC_ROUTES are public", "the x-middleware-subrequest header does not bypass authentication".
- TC-U10 (`tests/unit/lint-boundaries.test.ts`) › "a 'use server' directive fails lint", "a 'use cache' directive fails lint".
- TC-I04 › "unknown /api/v1 paths return 404 ROUTE_NOT_FOUND".
- Files: `src/server/http/define-route.ts`, `src/server/http/public-routes.ts`, `src/app/api/v1/[...path]/route.ts`, `src/proxy.ts`, `next.config.ts`, `Dockerfile`, `compose.yaml`.
