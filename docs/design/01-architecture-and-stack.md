# 01 · Architecture and stack

> **Scope.** The shape of the system and everything that makes it run: layers, the request path of one mutation, pinned versions and their traps, folder layout, import boundaries and the lint that enforces them, configuration, Docker, compose, scripts and CI.
> **Owns decisions** D-01 (one Next.js app, REST only), D-02 (pins), D-03 (layering), D-38 (Docker/compose), D-39 (env), D-49 (CI), and the compose half of D-34 (credential separation).
> **Read with** [02 domain and workflow](./02-domain-and-workflow.md) · [03 data model and integrity](./03-data-model-and-integrity.md) · [04 security and API](./04-security-and-api.md) · [05 frontend](./05-frontend.md) · [06 cross-cutting](./06-cross-cutting.md) · [07 testing](./07-testing.md) · [PLAN](../../PLAN.md).

---

## 1. Architecture at a glance

**One deployable, one door.** A single Next.js 16.4 App Router app (one folder, one image) serves both the React UI and a REST API under `/api/v1`. Every read and write the UI makes goes `HTTP route → service → repository → Postgres`. There are no Server Actions, no `'use cache'`, and Server Components read no data. They only render the shell (identity and nav via `getActor()`). That leaves exactly one path into the data, and Vitest, curl and Playwright all test that same path.

```mermaid
flowchart TB
    subgraph BROWSER["Browser"]
        UI["React client components<br/>features/*, TanStack Query, RHF + shared Zod"]
    end
    subgraph NEXTAPP["Next.js 16.4 standalone server: one image, one process"]
        PX["src/proxy.ts<br/>optimistic page redirect only"]
        SHELL["(app)/layout.tsx server component<br/>getActor for identity and nav, no data reads"]
        RH["src/app/api/v1/**/route.ts<br/>defineRoute pipeline"]
        SV["src/server/services/*<br/>withTx, claim row lock, decide, buildChain, recordEvent"]
        RP["src/server/repositories/*<br/>actor-scoped WHERE, claimVisibilityWhere"]
        DBC["src/server/db/client.ts<br/>PrismaClient + PrismaPg adapter"]
        ST["src/server/storage/*<br/>ReceiptStorage: S3, FS, Memory"]
    end
    PG[("PostgreSQL 18.6<br/>connected as expense_app<br/>triggers, CHECKs, grants")]
    OS[("SeaweedFS 4.48<br/>S3 API, bucket receipts")]
    SH["src/shared/*<br/>Zod schemas, DTOs, enums, policy, money, dates"]
    UI -->|page navigation| PX
    PX --> SHELL
    UI -->|fetch /api/v1 with session cookie| RH
    RH --> SV
    SV --> RP
    RP --> DBC
    DBC --> PG
    SV --> ST
    ST --> OS
    SH -.-> UI
    SH -.-> RH
```

**The learning path's "engineering flow", mapped to this codebase.** These are the files to open when tracing one request in the walkthrough.

| Flow step | Where it happens | File |
|---|---|---|
| Requirement | ADR + design doc + named test | `docs/adr/*`, `docs/design/*`, `tests/**` |
| Validation | strict shared Zod schemas in the route pipeline (422) | `src/shared/schemas/*`, `src/server/http/define-route.ts` |
| Authorization | role gate in `defineRoute` (403); resource scope in the SQL `WHERE` (404) | `define-route.ts`, `src/server/repositories/claim-visibility.ts` |
| Application logic | transaction, claim row lock, pure `decide()` / `buildChain()` | `src/server/services/*`, `src/server/authz/claim-policy.ts`, `src/server/routing/build-chain.ts` |
| Database | Prisma via the pg adapter; triggers, CHECKs and grants are the backstop | `src/server/db/*`, `prisma/migrations/*` |
| Response | `{data}` / `{error:{code,message,details,requestId}}`, `x-request-id`, `no-store` | `src/server/errors/map-error.ts` |
| Logging | pino JSON with `requestId` from AsyncLocalStorage; audit row joins on `request_id` | `src/server/logging/logger.ts`, `src/server/audit/record-event.ts` |
| Testing | in-process route calls on a real PG 18.6 as `expense_app` | `tests/integration/**`, [07](./07-testing.md) |

---

## 2. One mutation end to end: approve

This is the mutation to trace live in the walkthrough. Each layer has one job, and the database repeats the important checks. Proxy is drawn only for the page load: its matcher excludes `/api`, so it never sees API calls, and multipart bodies are never buffered by it.

```mermaid
sequenceDiagram
    autonumber
    actor A as Approver browser
    participant PX as proxy.ts
    participant RH as approve route.ts
    participant SV as approvals.service
    participant RP as repositories
    participant PG as Postgres (role expense_app)
    A->>PX: GET /approvals/C03 page navigation
    PX-->>A: cookie present so render the shell, otherwise 302 /login
    Note over PX,RH: matcher excludes /api, so API calls never pass through proxy
    A->>RH: POST /api/v1/claims/C03/approve with revision 1, cookie and Origin
    RH->>RH: accept or replace x-request-id, open AsyncLocalStorage context
    RH->>PG: authenticate: session by sha256(token) joined to the live users row
    RH->>RH: CSRF Origin check, role gate canApprove and not FINANCE, uuid param, strict ApproveInput
    RH->>SV: approve(ctx, claimId, input) with ctx = actor + requestId (C-26)
    SV->>PG: BEGIN via withTx, READ COMMITTED
    SV->>RP: lockClaimRoutedToMe(tx, actor, claimId)
    RP->>PG: SELECT the claim WHERE id matches AND EXISTS my PENDING step FOR NO KEY UPDATE OF c
    alt no row comes back
        SV->>RP: diagnose with my steps on the current revision
        SV-->>RH: 409 ALREADY_DECIDED or 403 NOT_IN_YOUR_QUEUE, transaction rolled back
    else claim locked
        SV->>RP: re-read my PENDING step on current_submission_id
        SV->>SV: input.revision must equal current_revision, else 409 REVISION_MISMATCH
        RP->>PG: UPDATE my step to APPROVED WHERE status is PENDING, expect count 1
        Note right of PG: approval_steps_guard re-checks eligibility (UC008) and stamps decided_at
        alt a next level exists
            RP->>PG: UPDATE next step from WAITING to PENDING
            Note right of PG: guard requires the previous level APPROVED (UC012), stamps activated_at
        else this was the final level
            RP->>PG: UPDATE claims SET status APPROVED
            Note right of PG: claims_guard requires every step APPROVED (UC011), stamps approved_at
        end
        SV->>RP: recordEvent(tx, ctx, STEP_APPROVED or CLAIM_APPROVED)
        RP->>PG: INSERT claim_events, trigger stamps occurred_at and tx_id
        SV->>PG: COMMIT
        Note right of PG: deferred checks run at COMMIT: assert_transition_audited (UC015), assert_claim_total_consistent (UC009)
        SV->>RP: findClaimForActor re-reads ClaimDetail with allowedActions
        SV-->>RH: ClaimDetail
    end
    RH->>RH: map AppError or SQLSTATE to the envelope, log claim.approved and http.request
    RH-->>A: 200 data ClaimDetail or error envelope, with x-request-id and Cache-Control no-store
    A->>A: setQueryData for the claim, invalidate approvals and history queries
```

What each layer proves (one line each, to say out loud):
- **Route (`defineRoute`)**: who you are (401), whether your persona may call this at all (403 `FORBIDDEN`), and whether the request is well formed (422). It runs no business logic. See the pipeline in [04](./04-security-and-api.md).
- **Service**: the decision, made under a row lock on the claim, using facts re-read inside the transaction. It returns specific 403/409 codes, writes one audit event and does no network I/O. Lock order and retries are in [02](./02-domain-and-workflow.md).
- **Repository**: the actor scope is part of the SQL itself. An out-of-queue claim never leaves Postgres, which is what "refused at the point of the query" means.
- **Postgres**: re-checks eligibility, chain order and audit completeness, and stamps every transition timestamp, so even raw SQL with the app's credentials can't skip a rule. Trigger catalogue in [03](./03-data-model-and-integrity.md).

---

## 3. Stack and pinned versions

Every dependency is pinned **exactly** (`pnpm add -E`) and the lockfile is committed. Versions were checked against the registries on 2026-10-12.

### 3.1 Toolchain, runtime and application dependencies

| Package / tool | Version | Why this one | Learning-path concept |
|---|---|---|---|
| Node.js | **24.21.0** (`.nvmrc`; local 24.13.1 must be upgraded) | Krypton LTS. Built-in `crypto.argon2` (≥ 24.7) for passwords, global `fetch` for the container healthcheck, AsyncLocalStorage for request context | Node.js runtime |
| pnpm | **10.34.6** (`packageManager`) | Strict `node_modules` catches phantom dependencies; `onlyBuiltDependencies` decides which packages may run install scripts | — (tooling) |
| Docker Engine / Compose | 29.8 / v5.5 (installed) | `depends_on` conditions, `--wait` | Docker fundamentals |
| `next` | **16.4.0 → 16.4.x OOB patch on Wed 14 Oct 2026** | App Router, Route Handlers, `output: 'standalone'`. 16.x is Active LTS and security fixes land on the latest minor | Next.js path · HTTP and REST |
| `react`, `react-dom`, `@types/react`, `@types/react-dom` | 19.3.0 | Matches the React that Next 16.4 bundles | — (home turf) |
| `@next/env` | = `next` | `loadEnvConfig()` makes the Prisma CLI and scripts read `.env` exactly like Next does. Under `tsx` in this `"type": "module"` repo, scripts use a default import (`import nextEnv from '@next/env'; nextEnv.loadEnvConfig(…)`): the named import fails there. `prisma.config.ts` is loaded by Prisma and keeps the named import | Environment configuration |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | **7.10.0** | v7 is GA and supported for 18 months after v8. The v8 RC lacks transaction isolation levels and P2002-style codes | Prisma ORM · migrations |
| `pg`, `@types/pg` | 8.23.1 | Driver under the adapter; raw `appSql` / `ownerSql` clients in tests and scripts | PostgreSQL fundamentals |
| `zod` | **4.6.5** | One schema validates the form in the browser and the request on the server | Validation |
| `@tanstack/react-query` | 5.104.1 | Cache and invalidation over REST; `useInfiniteQuery` for keyset pages | CRUD · pagination and filtering |
| `react-hook-form` / `@hookform/resolvers` | 7.89.0 / 5.9.1 | `useFieldArray` line editor with `zodResolver` | Validation (client side) |
| `@aws-sdk/client-s3` | 3.1145.0 | The S3 API, so the same code runs against SeaweedFS locally and any S3 store later; Azure Blob would be another `ReceiptStorage` adapter | Azure concepts (storage behind an interface) |
| `@aws-sdk/s3-request-presigner` | 3.1145.0 (OPTIONAL-§8 only) | Presigned URLs. Must equal the `client-s3` version | — |
| `pino` | **10.4.0** | JSON to stdout, redaction, a mixin that reads request context | Structured logging · request IDs |
| `pino-pretty` | 13.1.3 (dev, piped only) | Readable dev logs without in-process transports | Structured logging |
| `server-only` | 0.0.1 | Importing a server module into a client bundle fails the build | Authorization (server-side boundary) |
| `tailwindcss`, `@tailwindcss/turbopack` | 4.3.3 | CSS-first config; target for shadcn/ui. Wired as the create-next-app 16.4 template does it: a Turbopack loader rule in `next.config.ts` (§9.5), so there is **no** `postcss.config.mjs` and no `@tailwindcss/postcss` | — |
| shadcn/ui companions | `clsx` 2.1.1, `tailwind-merge` 3.7.0, `class-variance-authority` 0.7.1, `tw-animate-css` 1.4.0, `lucide-react`, `sonner` (pin what `shadcn init` installs) | Copy-in components, no runtime UI kit | — |

### 3.2 Dev dependencies

| Package | Version | Why | Learning-path concept |
|---|---|---|---|
| `typescript` | **6.0.3** | Last JS-based TypeScript. typescript-eslint supports `<6.1.0`, and TS 7 has no compiler API for type-aware lint | — |
| `@types/node` | 24.19.1 | Must be listed in `compilerOptions.types` because the TS 6 default is `[]` | Node.js runtime |
| `eslint` | **9.39.5** | ESLint 10 breaks the plugin peer ranges inside `eslint-config-next` | — |
| `eslint-config-next` | = `next` | Flat `core-web-vitals` + `typescript` configs | Next.js path |
| `typescript-eslint` | 8.71.0 | Type-aware rules (`no-floating-promises`, `switch-exhaustiveness-check`) | Error handling |
| `eslint-config-prettier` | 10.1.8 | Turns off rules that fight Prettier | — |
| `prettier` / `prettier-plugin-tailwindcss` | 3.9.9 / 0.8.1 | Formatting and class sorting | — |
| `vitest`, `@vitest/coverage-v8` | **5.0.3** | Projects `unit`, `integration`, `component` | Automated testing |
| `vite` | 8.3.4 | Explicit peer of Vitest 5 | — |
| `@vitejs/plugin-react` / `vite-tsconfig-paths` | 6.1.1 / 6.1.1 | Component tests; the `@/*` alias inside Vitest (P0 uses Vite 8's built-in `resolve.tsconfigPaths` instead; Vite warns when the plugin is also used) | — |
| `jsdom` | 30.1.1 | Component test environment | Automated testing |
| `@testing-library/react` / `dom` / `user-event` / `jest-dom` | 16.3.3 / 10.4.2 / 14.6.7 / 7.0.1 | Component tests | Automated testing |
| `testcontainers`, `@testcontainers/postgresql` | **12.2.0** | Real `postgres:18.6-trixie` with the same roles script as compose | Automated testing (integration) · PostgreSQL |
| `@playwright/test` | **1.63.0** | E2E against the compose stack (1.64 is too fresh) | Automated testing (e2e) |
| `tsx` | 4.23.15 | Runs `prisma/seed.ts` and `scripts/*.ts` | Node.js runtime |
| `pg`, `pg-copy-streams` | 8.23.1 / 7.0.0 (test-only) | Raw second connections for the concurrency and COPY cases of TC-I12/TC-I13 (the versions the SQL proof ran) | Automated testing · PostgreSQL |
| `fast-check` | 4.10.2 (OPTIONAL) | Property tests | — |
| `husky` / `lint-staged` | 9.1.7 / 17.6.0 (OPTIONAL) | Pre-commit hooks; CI stays the real gate | — |

OPTIONAL (buffer only, D-47): `@vercel/otel` + `@prisma/instrumentation` 7.10.0, pinned when added. EXPLAIN needs no package: `scripts/perf/explain.ts` (D-48).

### 3.3 Images

| Image | Why | Learning-path concept |
|---|---|---|
| `node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66` (digest-pinned in P0; bump tag and digest together) | Debian glibc, so Prisma's schema-engine and collations behave like managed Postgres; multi-arch (arm64 Mac, amd64 CI) | Docker fundamentals |
| `postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336` (compose and Testcontainers pin the same digest) | Native `uuidv7()`, so even trigger, raw-SQL and seed inserts get time-ordered ids | PostgreSQL · Azure managed PostgreSQL |
| `chrislusf/seaweedfs:4.48` | Apache-2.0; one-process `weed mini` with S3 on :8333; enforces SigV4 | Docker (multi-service) |
| `grafana/k6:2.3.0` (OPTIONAL) | §8 load test under compose profile `load` | EXPLAIN / performance |
| `mcr.microsoft.com/playwright:v1.63.0-noble` (OPTIONAL CI) | Same version as `@playwright/test` | Automated testing |

**Not used:** `csv-stringify` (own `csv.ts`), `date-fns` (Intl only), `nuqs` (own `useUrlQuery`), `@node-rs/argon2` (`node:crypto`), `better-auth`, `next-auth`, `jose` / `openid-client` (Entra is ADR text only). **Never** upgrade Prisma to ≥ 8 or TypeScript to ≥ 7 without an ADR.

### 3.4 Upgrade and fallback policy

- **Next.js security patch, Wed 14 Oct 2026 (the advisory's release date; done in P1).** Run `pnpm add -E next@16.4.x @next/env@16.4.x eslint-config-next@16.4.x`, then `pnpm verify` and a compose smoke test, and commit it on its own as `chore(security): next 16.4.x (Oct-14 advisory)`. If 16.4.x breaks the build, fall back to the patched 16.3.x line.
- **Fallbacks decided in P0** (record which were used in ADR-0001). P0 as built needed none of the four build fallbacks below:

| Trouble | Fallback, in order |
|---|---|
| Standalone build (missing hashed `@prisma/client-*` external, pnpm symlinks) | `nodeLinker: hoisted` in `pnpm-workspace.yaml` → `next build --webpack` → non-standalone `next start` |
| ESM import errors from the generated client under `tsx` | generator `importFileExtension = "ts"` → drop `"type": "module"` |
| TS 6 defaults trip generated or Next types | TypeScript 5.9.3 |
| Vitest 5 incompatibility | Vitest 4.1.x |
| SeaweedFS fails its 30-minute timebox (the P6 storage gate, [PLAN §5](../../PLAN.md#decision-gates)) | the FS recipe in §11.3 (`RECEIPT_STORAGE_DRIVER=fs`, app volume, no `objectstore`) |

---

## 4. Version gotchas (Day-1 traps)

| # | Trap | Symptom | Fix |
|---|---|---|---|
| 1 | `pnpm add prisma` resolves `latest` = **8.0.0-rc** | v8 APIs, no isolation levels; the default docs and Docker guide now describe v8 | `pnpm add -E prisma@7.10.0 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0`; read `prisma.io/docs/orm/v7/...` |
| 2 | `pnpm add -D typescript` resolves **7.0** (Go port) | typescript-eslint can't load; no compiler API | Pin 6.0.3; set `"types": ["node"]`; don't use `baseUrl` (deprecated) |
| 3 | `pnpm add -D eslint` resolves **10.x** | peer conflicts in react / import / jsx-a11y plugins | Pin 9.39.5 |
| 4 | `create-next-app@16.4` turns **Cache Components on** by default and pulls its own versions | cross-user caching risk; Suspense-boundary friction | `cacheComponents: false`; re-pin everything after scaffolding |
| 5 | Next 16 renamed `middleware.ts` → **`src/proxy.ts`** exporting `proxy` (Node runtime) | old auth tutorials gate the API in middleware, which CVE-2025-29927 showed can be skipped with one header | Proxy does page redirects only; matcher excludes `/api`; auth runs inside every handler ([04](./04-security-and-api.md)) |
| 6 | Next 16 removed `next lint`; `next build` no longer lints | lint errors reach `main` silently | `pnpm lint` is its own CI step; `typecheck` = `next typegen && tsc --noEmit` |
| 7 | Next 16 request APIs are async | `params.claimId` is a Promise | `await ctx.params` inside `defineRoute`. Handlers read cookies from `req.cookies`, never `next/headers`, so tests can call them in process |
| 8 | Standalone binds to the container id | app unreachable inside Docker | `HOSTNAME=0.0.0.0`; copy `public/` and `.next/static`; run `node server.js` |
| 9 | `next build` evaluates route modules ("Collecting page data") | build fails with no `.env` | No module-level `env()` / `getDb()` calls; all getters are lazy and memoized |
| 10 | `next.config.ts` `headers()` is evaluated at build time | runtime values are baked in | Only static headers there |
| 11 | **Prisma 7 config model** | no URL in `schema.prisma`; `.env` not auto-loaded; no auto-seed after `migrate dev` / `reset`; `--skip-generate` removed; a driver adapter is mandatory; the client is generated into the source tree | `prisma.config.ts` calls `loadEnvConfig`; `db:reset` seeds explicitly; `PrismaPg` adapter; run `pnpm db:generate` before typecheck, test and build; `src/generated/` is gitignored |
| 12 | Prisma 7 is ESM-first | `tsx` errors such as `Cannot find module './internal/class.js'` | `"type": "module"`, generator `moduleFormat = "esm"`; fallback per §3.4 |
| 13 | pnpm 10 blocks install scripts | `prisma migrate` has no schema-engine (worst inside the tools image) | `onlyBuiltDependencies` (§9.5); watch for "Ignored build scripts" and run `pnpm approve-builds` |
| 14 | **PG 18 image moved `PGDATA`** | data lost or mount ignored | Mount the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data`; initdb scripts run only on an empty volume (`docker compose down -v` to re-run) |
| 15 | PG 18 `uuidv7()` may be missing in a cloud region | migration fails on PG 17 | Fallback is Prisma `@default(uuid(7))`; everything else is unchanged |
| 16 | Pointing the app at `POSTGRES_USER` or giving it `env_file: .env` | the app process holds superuser and owner credentials, so every DB guard is bypassable (RT-B3) | `expense_app` only; per-service `environment:`; boot self-check (§9.2) |
| 17 | `prisma migrate reset` recreates schema `public` | schema-level grants vanish after `db:reset` | The `…_privileges` migration also re-asserts `REVOKE ALL ON SCHEMA public FROM PUBLIC` and `GRANT USAGE ON SCHEMA public TO expense_app` (idempotent; added after the SQL proof). TC-I07 runs on a fresh DB via `migrate deploy`, so it does **not** prove this. Verify by hand: `pnpm db:reset` against the compose postgres, then as `expense_app` `SELECT count(*) FROM claims` succeeds and `CREATE TABLE x(i int)` fails with 42501. P0 verified the privileges as `expense_app` after `migrate deploy`; the post-reset check waits for the user's consent (trap 31) |
| 18 | `server-only` throws outside the `react-server` condition | Vitest and `tsx` crash on `import 'server-only'` | Vitest aliases it to `tests/helpers/empty-module.ts`; `tsx` scripts that import `src/server` modules run with `--conditions=react-server`: the seed, `verify:integrity`, `policy:activate-tier`, `perf:seed`, `perf:explain` (§12; services never import `next/*` or React, so nothing else changes). Next handles it internally in server bundles |
| 19 | AWS SDK ≥ 3.729 adds CRC32 checksums by default | `SignatureDoesNotMatch` / 400 from S3-compatible stores | `requestChecksumCalculation` and `responseChecksumValidation: 'WHEN_REQUIRED'`, `forcePathStyle: true`, region `us-east-1` |
| 20 | MinIO images are gone; LocalStack needs an auth token; SeaweedFS **runs unauthenticated without both keys** | open bucket, or `compose up` needs an account | SeaweedFS with **both** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set |
| 21 | Vitest 5 changes | `clearMocks` is on by default; unawaited `expect(...).resolves` fails; config isn't searched in parent dirs | Install `vite` as a direct devDependency; gitignore `.vitest/` |
| 22 | Testcontainers 12 needs a running Docker daemon | integration suite hangs or fails | Start Docker Desktop with ≥ 6 GB RAM. On a machine without Docker, set `TEST_PG_SUPERUSER_URL` to a disposable, empty PG 18 superuser URL: global setup then creates a fresh `expense_claims_test_<hex>` database there and runs the same `01-roles.sh` SQL (Testcontainers stays the default) |
| 23 | pino worker-thread transports under Next bundling | missing logs / crashes | No `transport:`; pipe output (`pnpm dev:pretty`) |
| 24 | `instrumentation.ts` `register()` throwing may not stop the server | a misconfigured container stays up | Call `process.exit(1)` explicitly; P0 check: a broken `.env` makes the app container exit non-zero |
| 25 | `docker compose up --wait` with a one-shot service | `migrate` shows Exited (0) | P0 exit check: `docker compose up --build --wait` returns 0 with `migrate` Exited (0) and `app` healthy |
| 26 | `import { loadEnvConfig } from '@next/env'` in a `tsx` script under `"type": "module"` | the named import fails | Default import: `import nextEnv from '@next/env'; nextEnv.loadEnvConfig(process.cwd())`. `prisma.config.ts` is unaffected |
| 27 | create-next-app 16.4 wires Tailwind 4 through Turbopack | a hand-added `postcss.config.mjs` / `@tailwindcss/postcss` duplicates the pipeline | Keep the template: `turbopack.rules['*.css']` with the `@tailwindcss/turbopack` loader in `next.config.ts`; no PostCSS config |
| 28 | `no-restricted-imports` `group` patterns use gitignore semantics | `['@/server/**', '!@/server/auth/rsc']` never re-includes `rsc`, because its parent directory is already excluded | Use a regex pattern for the pages zone: `'^@/server(?:$|/(?!auth/rsc$))'` (§7.2) |
| 29 | During initdb, Postgres listens on the Unix socket only | a socket `pg_isready` reports healthy while `01-roles.sh` is still running, and `migrate` fails on missing roles | Probe TCP: `pg_isready -h 127.0.0.1 -p 5432 …` (§11.1) |
| 30 | git doesn't track an empty `public/` | `COPY --from=build /app/public` fails on a clean clone | The build stage runs `mkdir -p public` before `next build` (§10.1) |
| 31 | Prisma 7.10 detects AI agents | `prisma migrate reset` (so `pnpm db:reset`) refuses to run under an agent | Only with the user's explicit consent (`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, set by the user, never by the agent). Agents ask instead |
| 32 | typescript-eslint's project service only type-checks files on disk | TC-U10's virtual `lintText` fixtures fail to parse with type-aware rules | TC-U10 adds the `disableTypeChecked` override; the boundary rules under test still come from the real `eslint.config.mjs` |

---

## 5. Rejected alternatives

| Area | Chosen | Rejected, and why |
|---|---|---|
| Framework | One Next.js App Router app | **Express API + Vite SPA**: two deployables, CORS and cookie plumbing, duplicated config. `defineRoute` gives us Express's middleware chain inside one handler |
| Server interface | REST Route Handlers under `/api/v1` | **Server Actions**: every `'use server'` function is an implicit public POST endpoint, a second enforcement path, and awkward to call from curl, Vitest or k6. **tRPC**: RPC semantics instead of HTTP resources and status codes. Services are framework-agnostic, so either could be layered on later |
| Server Components | Render the shell only | **RSC reads through services** (a second read path); **RSC fetching its own API** (a self-request hop) |
| Caching | `cacheComponents: false`, `'use cache'` banned | **The 16.4 default**: every screen is per-user and authorization-scoped, so there is nothing safe to cache and a mis-keyed cache leaks claims |
| Auth placement | Inside every handler | **Auth in middleware/proxy** (CVE-2025-29927) |
| ORM | Prisma 7.10 + `@prisma/adapter-pg` | **Prisma 8 RC** (missing isolation levels and P2002-style codes); **Drizzle / Kysely / raw pg** (the spec and the learning path name Prisma) |
| Database | PostgreSQL 18.6 | **PG 17 + app-side ids** (trigger, raw-SQL and seed inserts lose DB-generated v7 ids) |
| Base images | Debian `trixie-slim` | **Alpine**: musl and openssl detection quirks with Prisma's schema-engine save ~40 MB and cost days |
| Language | TypeScript 6.0.3 strict | **TS 7.0** (no API for type-aware lint); **TS 5.9** (one more migration later) |
| Lint | ESLint 9 + typescript-eslint + eslint-config-next | **Biome** (no path-zone import boundaries, no Next plugin parity); **ESLint 10** (peer conflicts) |
| Package manager | pnpm 10 | **npm** (no build-script allowlist); **pnpm 11/12** (config migration with no benefit for the POC) |
| Object store | SeaweedFS 4.48, FS adapter as fallback | **MinIO** (archived April 2026, images gone); **LocalStack** (an auth token breaks "only a `.env`"); **Garage** (manual CLI bootstrap); **S3Mock** (test double); **local disk as primary** (§8 says object store); **RustFS** (too young; the FS adapter is a simpler fallback) |
| Migrations | One-shot `migrate` job (tools image) | **`migrate deploy` in the app entrypoint**: replicas race, the runtime needs DDL rights and the CLI, and boot is coupled to migration time |
| Credentials | One `.env` for interpolation; per-service `environment:` | **`env_file: .env` on services** (hands the app owner and superuser credentials); **separate `.env.db` / `.env.migrate` / `.env.app` files** (breaks "only a documented `.env`"; per-service lists give the same isolation) |
| Env parsing | Lazy, memoized Zod `env()` | **Top-level parsing** (image build fails); **`@t3-oss/env-nextjs`** (extra dependency, and there is no client env) |
| Tests | Vitest + Testcontainers on real PG 18.6 | **Jest** (CJS-first); **SQLite / pg-mem** (no triggers or row locks); **mocking Prisma** (can't prove a trigger fires) |
| E2E | Playwright against the compose image | **Cypress**; **e2e against `next dev`** (doesn't prove the image) |
| Logging | pino to stdout | **`console.log`**; **in-process transports** |
| Load | k6 (OPTIONAL) | **autocannon** (no scenarios or thresholds) |
| Money / dates / CSV | Integer paise, `Intl`, own `csv.ts` | **dinero.js** (pre-1.0), **date-fns(-tz)**, **csv-stringify** (web-stream mismatch; we need custom escaping anyway) |

Authentication alternatives (Better Auth, Auth.js, self-issued JWTs) are covered in [04](./04-security-and-api.md).

---

## 6. Folder layout

The root holds config only. `src/` uses the Next.js `src/` layout. Names match the canonical module list, so cross-doc references and the tests resolve.

```text
expense-claims/
├─ .github/workflows/ci.yml               # made green on GitHub in P8 (§13)
├─ docker/
│  ├─ postgres/initdb/01-roles.sh          # roles, DB ownership, DB-level REVOKEs (first boot; also used by Testcontainers)
│  └─ tools/entrypoint.sh                  # migrate | seed | ensure-bucket | release
├─ docs/
│  ├─ design/01-…07-*.md                   # this set
│  ├─ adr/0001-…0008-*.md                  # one page per likely RM question
│  ├─ perf/*.txt                           # EXPLAIN (ANALYZE, BUFFERS) evidence
│  └─ walkthrough.md  demo-script.md  runbook.md
├─ e2e/
│  ├─ auth.setup.ts                        # storageState per persona via the login API
│  └─ *.spec.ts                            # journey-submit-approve-export, foreign-claim-404, stack-smoke, …
├─ load/export.k6.js                       # OPTIONAL
├─ prisma/
│  ├─ schema.prisma                        # generator + provider only; URL lives in prisma.config.ts
│  ├─ migrations/                          # …_init, …_integrity_core, …_privileges, …_workflow, …_receipts
│  └─ seed.ts  seed-personas.ts  seed-claims.ts   # seedReference() always; cast + C01–C12 only when SEED_ON_START=true and users is empty
├─ public/                                # may be empty; git doesn't track it, so the Docker build stage runs mkdir -p public
├─ scripts/
│  ├─ ensure-bucket.ts  verify-integrity.ts  policy-activate-tier.ts
│  ├─ perf/seed-perf.ts  perf/explain.ts
│  └─ demo/*.sh                            # edit-approved.sh, sql-attacks.sh
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx  globals.css  not-found.tsx  global-error.tsx  # layout.tsx renders <Providers> (QueryClient, Toaster); the scaffolded page.tsx is deleted in P1
│  │  ├─ (auth)/login/page.tsx
│  │  ├─ (app)/layout.tsx  (app)/page.tsx  (app)/error.tsx       # layout: getActor() identity, nav, redirect — no data reads; page.tsx: / → redirect /claims
│  │  ├─ (app)/claims/page.tsx  claims/new/page.tsx  claims/[id]/page.tsx
│  │  ├─ (app)/approvals/page.tsx  approvals/[claimId]/page.tsx
│  │  ├─ (app)/finance/claims/page.tsx  finance/claims/[id]/page.tsx  finance/export/page.tsx
│  │  └─ api/
│  │     ├─ health/live/route.ts  health/ready/route.ts         # public probes, outside /api/v1
│  │     └─ v1/
│  │        ├─ auth/login/route.ts  auth/logout/route.ts  auth/me/route.ts
│  │        ├─ categories/route.ts
│  │        ├─ claims/route.ts                                  # GET mine, POST draft
│  │        ├─ claims/[claimId]/route.ts                        # GET, PUT replace-set, DELETE draft
│  │        ├─ claims/[claimId]/submit/route.ts   …/recall/route.ts
│  │        ├─ claims/[claimId]/approve/route.ts  …/reject/route.ts  …/history/route.ts
│  │        ├─ claims/[claimId]/line-items/[lineItemId]/receipts/route.ts   # POST multipart
│  │        ├─ claims/[claimId]/receipts/[receiptId]/route.ts           # DELETE
│  │        ├─ claims/[claimId]/receipts/[receiptId]/content/route.ts   # GET stream
│  │        ├─ approvals/route.ts
│  │        ├─ finance/claims/route.ts
│  │        ├─ finance/exports/approved-claims/route.ts         # text/csv stream
│  │        └─ [...path]/route.ts                               # 404 ROUTE_NOT_FOUND
│  ├─ proxy.ts                                                  # optimistic page redirect only
│  ├─ instrumentation.ts                                        # env() + boot checks, exit 1 on failure
│  ├─ server/                                                   # every file starts with import 'server-only'
│  │  ├─ env.ts
│  │  ├─ db/          client.ts (getDb, PrismaPg) · tx.ts (withTx, type Tx) · pg-error.ts (readSqlState) · introspection.ts (readRoleAttributes, countDisabledTriggers, ping, readinessProbe)
│  │  ├─ http/        define-route.ts (ROUTE_META) · public-routes.ts · request-context.ts (AsyncLocalStorage) · csrf.ts · call-meta.ts (callMeta(req) → { ip, userAgent })
│  │  ├─ auth/        session.ts (createSession, authenticate) · password.ts · cookie.ts (sessionCookieName) · rsc.ts (getActor) · actor.ts · runtime-role.ts (assertRuntimeRole)
│  │  ├─ authz/       claim-policy.ts (pure decide, allowedActions, submissionOutcome)
│  │  ├─ errors/      codes.ts · app-error.ts · map-error.ts
│  │  ├─ routing/     build-chain.ts · policy.ts (assertPolicyWellFormed, assertPolicyLoadsWellFormed) · org-loader.ts
│  │  ├─ audit/       events.ts (Zod union) · record-event.ts
│  │  ├─ services/    context.ts (ServiceCtx, SeedClock) · claims · lifecycle · approvals · receipts · finance · export · auth · health  (*.service.ts; signatures in C-26)
│  │  ├─ repositories/ claim-visibility.ts (claimVisibilityWhere, findClaimForActor) · claims (lockOwnedClaim, lockClaimRoutedToMe) · line-items · receipts · submissions · steps · events · users · sessions · categories · tiers · export  (*.repo.ts)
│  │  ├─ storage/     receipt-storage.ts · s3-receipt-storage.ts · memory-receipt-storage.ts · fs-receipt-storage.ts · sniff.ts
│  │  ├─ export/      csv.ts · export-stream.ts
│  │  └─ logging/     logger.ts
│  ├─ shared/         enums.ts · errors.ts · policy.ts · money.ts · dates.ts · cursor.ts · schemas/* · dto/*   # isomorphic
│  ├─ features/       claims/ · approvals/ · finance/ · auth/                                                 # client feature modules
│  ├─ components/     ui/ (shadcn copy-ins) · shared components
│  ├─ lib/            api-client.ts (apiFetch, ApiError) · query-keys.ts · use-url-query.ts
│  └─ generated/prisma/                                         # prisma generate output — gitignored, never edited
├─ tests/
│  ├─ unit/  component/
│  ├─ integration/   spike/ auth/ http/ observability/ db/ claims/ integrity/ authz/ workflow/ audit/ lists/ receipts/ export/
│  └─ helpers/       global-setup.ts · integration-setup.ts · db.ts · http.ts · auth.ts · factories.ts · route-manifest.ts · empty-module.ts
├─ .dockerignore  .env.example  .gitignore  .nvmrc  .prettierignore
├─ compose.yaml  Dockerfile  components.json
├─ eslint.config.mjs  prettier.config.mjs                 # no postcss.config.mjs: Tailwind runs through the Turbopack loader
├─ next.config.ts  prisma.config.ts  tsconfig.json  vitest.config.mts  playwright.config.ts
├─ package.json  pnpm-lock.yaml  pnpm-workspace.yaml
└─ README.md
```

`.gitignore` adds `.env`, `src/generated/`, `.next/`, `.vitest/`, `coverage/`, `playwright-report/`, `test-results/`, `e2e/.auth/` and `.data/`.

---

## 7. Layering rules and how lint enforces them

### 7.1 The rules

| Zone | May import | Must not import | Why |
|---|---|---|---|
| `src/app/api/**/route.ts` | `@/server/http/*`, `@/server/services/*`, `@/shared/*` | repositories, `@/server/db/client`, `@/generated/prisma/*`, `@prisma/*`, `pg`, `next/headers` | A handler translates HTTP into a service call and nothing more |
| `src/app/**` pages and layouts (not `api/`) | `@/server/auth/rsc` (the only server import), `features`, `components`, `lib`, `shared` | anything else under `@/server/**`, Prisma | Server Components render the shell; data comes through `/api/v1` (D-04) |
| `src/server/services/**` | repositories, `@/server/db/tx`, `storage`, `audit`, `routing`, `authz`, `errors`, `logging`, `shared` | `next`, `next/*`, `@/server/http/*`, `@/server/db/client`, `@/generated/prisma/*`, `@prisma/*` | Framework-agnostic, so it is unit-testable and runs under `tsx` (seed) |
| `src/server/repositories/**` | `@/server/db/*`, `@/generated/prisma/*`, `@/server/auth/actor`, `errors`, `shared` | `next/*`, services, `@/server/http/*` | The only layer that builds queries; every function takes the actor |
| `src/server/db/**` | `@/generated/prisma/*`, `@prisma/*`, `pg` | `next/*` | Owns the client, transaction helper and SQLSTATE reader |
| `src/server/**` (all other folders) | each other | `next/headers` (except `auth/rsc.ts`) | Cookies come from `NextRequest`, so handlers stay callable in tests |
| `src/shared/**`, `src/lib/**`, `src/components/**`, `src/features/**` | each other, UI packages | `@/server/**`, `@/generated/prisma/*`, `@prisma/*` | The UI cannot touch the database (also enforced by `server-only` at build time) |
| Everywhere | — | `'use server'`, `'use cache'`, `$queryRawUnsafe`, `$executeRawUnsafe` | One mutation path; no cross-user cache; raw SQL only as tagged, parameterised templates |

Conventions that go with the rules:
- **Lazy getters only.** `env()`, `getDb()` and `getStorage()` are memoized functions, never module-level values, so the image builds with zero env.
- **Handlers** are always `export const <METHOD> = defineRoute({...})`. **Services** throw `AppError(code, message, details?)` and never see a `Request` or a `Response`.
- **Repository signatures** always take the actor ([C-26](./00-decisions-and-contracts.md#c-26-repository-and-service-signatures)): locks and writes are `(tx, actor, claimId, childId?)`, so a child id is always bound to its claim (RT-B2); `findClaimForActor(actor, claimId, select)` reads through `getDb()` after commit. **Service signatures** are `(ctx: ServiceCtx, ...ids, input?)`.
- Files are `kebab-case.ts`; services `noun.service.ts`; repositories `noun.repo.ts`; tests `*.test.ts` (unit, component) and `*.int.test.ts` (integration).
- Money is `…Minor` integer paise; business dates are `YYYY-MM-DD` strings; instants are ISO-8601 UTC with `Z` ([03](./03-data-model-and-integrity.md)).
- Commits follow Conventional Commits (`feat(claims): …`).

### 7.2 `eslint.config.mjs`

Rule options **do not merge** across flat-config blocks: for any one file, the last matching block's `no-restricted-imports` wins. So each zone lists its complete pattern set.

```js
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const PRISMA = { group: ['@/generated/**', '@/server/db/client', '@prisma/*', 'pg'],
                 message: 'Only src/server/repositories and src/server/db may touch Prisma or pg (D-03).' };
const NEXT = { group: ['next', 'next/*'], message: 'Services and repositories are framework-agnostic.' };
const NEXT_HEADERS = { group: ['next/headers'], message: 'Read cookies from NextRequest; only src/server/auth/rsc.ts may use next/headers.' };
const REPOS = { group: ['@/server/repositories/*'], message: 'Route handlers call services, never repositories.' };
const HTTP = { group: ['@/server/http/*'], message: 'Only route handlers know about HTTP.' };
const SERVICES = { group: ['@/server/services/*'], message: 'Repositories never call services.' };
const SERVER = { group: ['@/server/**'], message: 'Client and isomorphic code cannot import server modules.' };
// A regex, not group ['@/server/**', '!@/server/auth/rsc']: groups use gitignore semantics, where a file can't be
// re-included once its parent directory is excluded, so that negation never fires (§4 trap 28).
const PAGES = { regex: '^@/server(?:$|/(?!auth/rsc$))', message: 'Pages and layouts may import only @/server/auth/rsc (D-04).' };

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error',
        { selector: "ExpressionStatement[directive='use server']", message: 'Server Actions are banned: mutations go through /api/v1 (ADR-0001).' },
        { selector: "ExpressionStatement[directive='use cache']", message: "'use cache' is banned: every response is actor-scoped." },
        { selector: "MemberExpression[property.name='$queryRawUnsafe']", message: 'Use the tagged $queryRaw template.' },
        { selector: "MemberExpression[property.name='$executeRawUnsafe']", message: 'Use the tagged $executeRaw template.' },
      ],
    },
  },
  { files: ['src/app/**/*.{ts,tsx}'], ignores: ['src/app/api/**'], rules: restrict(PAGES, PRISMA) },
  { files: ['src/app/api/**/*.ts'], rules: restrict(PRISMA, REPOS, NEXT_HEADERS) },
  { files: ['src/server/**/*.ts'], rules: restrict(NEXT_HEADERS) },
  { files: ['src/server/services/**/*.ts'], rules: restrict(PRISMA, NEXT, HTTP) },
  { files: ['src/server/repositories/**/*.ts'], rules: restrict(NEXT, HTTP, SERVICES) },
  { files: ['src/server/db/**/*.ts'], rules: restrict(NEXT) },
  { files: ['src/server/auth/rsc.ts'], rules: { 'no-restricted-imports': 'off' } },
  { files: ['src/{shared,lib,components,features}/**/*.{ts,tsx}'], rules: restrict(SERVER, PRISMA) },
  prettier,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'src/generated/**', 'coverage/**', '.vitest/**',
                 'playwright-report/**', 'test-results/**', 'docs/reference/**']),   // docs/reference: archived SQL-proof evidence
]);
```

`prettier.config.mjs`: `{ singleQuote: true, trailingComma: 'all', printWidth: 100, plugins: ['prettier-plugin-tailwindcss'] }`.

**Proof that the rules bite.** TC-U10 `lint-boundaries.test.ts` runs ESLint's Node API (`new ESLint({ overrideConfig: [tseslint.configs.disableTypeChecked] }).lintText(code, { filePath })`) on fixtures placed in each zone. The fixtures are text, not files on disk, so the project service can't type-check them; `disableTypeChecked` switches off only the type-aware rules, and the boundary rules under test come from the real config unchanged: "importing @/generated/prisma from src/app fails lint" · "importing @/server from src/components fails lint" · "a 'use server' directive fails lint" · "a 'use cache' directive fails lint". So "the UI cannot touch the database" is a failing build, not a convention.

---

## 8. Enforcement layers: which layer holds each invariant

The UI column is **cosmetic**: buttons come from the server's `allowedActions`. Deleting every role check from React changes how the UI looks, not what is allowed. The DB column is the guarantee, because the app's credentials cannot turn it off (row 16).

| Invariant (requirement) | UI | Route (`defineRoute`) | Service | Repository | Database | Proof |
|---|---|---|---|---|---|---|
| 1. `total_minor = Σ lines` (§3.1, §6-5) | shows a preview total, never sends one | strict Zod: total-like key → 422 `TOTAL_IS_DERIVED` | never writes the column | no total in any write payload | 3 statement triggers recompute; `claims_guard` UC003; deferred UC009 at COMMIT; `v_claim_total_drift` | TC-I12, TC-I13, TC-I00 |
| 2. Valid line data (§6-1) | `zodResolver` on the same schema | 422 `VALIDATION_FAILED` with `issues[].path` | category exists and is active → 422 `CATEGORY_INACTIVE` | — | CHECKs; UC013 inactive category; UC014 future date; FK | TC-I10 |
| 3. No empty submission (§6-1) | Submit shown only if `allowedActions` has `SUBMIT` | — | 422 `NO_LINE_ITEMS` | — | `claims_guard` UC004; `claim_submissions_verify` UC004 | TC-I15 |
| 4. Approved = read-only (§3.4) | read-only view | — | owner lock then status → 409 `CLAIM_LOCKED` | owner-scoped `FOR NO KEY UPDATE` | `claims_guard` UC001; line and receipt triggers call `assert_claim_editable` | TC-I11 |
| 5. No edits while SUBMITTED (§3.2) | editor read-only, "Recall to edit" | — | 409 `CLAIM_NOT_EDITABLE`, hint `RECALL_TO_EDIT` | owner-scoped lock | UC002 | TC-I21, TC-I11 |
| 6. See only your claims or your queue (§3.5, §6-4) | no client-side filtering logic | 401 without a session | passes the `Actor` everywhere | `claimVisibilityWhere(actor)` AND-composed into every read; no unscoped `findClaimById` | — (RLS is NOT PLANNED, D-46) | TC-I17, TC-I18, TC-I24, TC-I25 |
| 7. Only the PENDING approver decides (§6-2) | buttons from `allowedActions` | role gate → 403 `FORBIDDEN` | 403 `NOT_IN_YOUR_QUEUE` / 409 `ALREADY_DECIDED` / 409 `REVISION_MISMATCH` | PENDING-scoped lock `lockClaimRoutedToMe` | `approval_steps_guard` UC008 re-check, UC006 terminal steps; one PENDING per submission (partial unique) | TC-I19, TC-I20 |
| 8. Finance never approves; reads only (§3.5) | no action buttons | 403 `FORBIDDEN` on approve, reject; `/finance/*` FINANCE only | `requireRole(actor, 'FINANCE')` first line of finance and export services | `financeClaimsWhere(actor)` throws unless FINANCE | CHECK `users_finance_cannot_approve`; UC008 at decision time | TC-I19, TC-U09 |
| 9. Chain matches the tier policy (§3.2) | stepper displays it | — | `buildChain` → 422 `ROUTING_UNRESOLVABLE` | tiers read-only | `claims_guard` UC012 (step count = applicable active tiers); `UNIQUE(submission_id, approver_id)`; SELECT-only on tiers | TC-U03, TC-I16, TC-I15 |
| 10. History never lost (§3.3, §4) | timeline renders it | — | new revision + snapshot on every submit | — | `claim_submissions` INSERT-only + `claim_submissions_verify` UC016; `forbid_mutation` UC007; snapshot receipts never deleted (D-31) | TC-I22 |
| 11. Every transition audited (§6-7) | — | `x-request-id` flows into the event | `recordEvent(tx, ctx, event)` once per request | events repo inserts only | deferred `assert_transition_audited` UC015; SELECT + INSERT only | TC-I23 |
| 12. Child ids belong to the path claim (RT-B2) | sends `lineItemId` | uuid path params | incoming ids ⊆ claim's lines, else 404 `LINE_ITEM_NOT_FOUND` | `WHERE id AND claim_id`; `(tx, actor, claimId, childId)` | `claim_id` immutable UC010; composite FK `(line_item_id, claim_id)` | TC-I14 |
| 13. Transition times can't be backdated (RT-M5) | — | — | never passes timestamps | — | triggers stamp `now()` for `expense_app`; UC010 outside a transition | TC-I28 |
| 14. Every route authenticated (§6-3) | proxy redirect (UX only) | `auth: 'required'` unless in `PUBLIC_ROUTES` | requires an `Actor` argument | — | — | TC-I01, TC-E04 |
| 15. Export = approved in period only (§3.6) | status fixed to APPROVED | FINANCE gate; other `status` → 422 `EXPORT_STATUS_NOT_ALLOWED` | `requireRole`; `asOf` cap | `status = 'APPROVED'` + `approved_at` range; rows from the approved snapshot | CHECK `claims_approved_at_iff_approved`; UC011 | TC-I28 |
| 16. App credentials can't bypass rows 1–15 (D-34) | — | — | — | — | `expense_app` owns nothing, no TRIGGER / TRUNCATE / TEMP; boot `assertRuntimeRole()`; `/api/health/ready` 503 if a trigger is disabled | TC-I07, TC-I06, TC-E06 |

---

## 9. Configuration

### 9.1 `src/server/env.ts`: lazy, memoized, Zod-validated

`next build` evaluates route modules, so env must be read lazily. A misconfigured server must refuse to start, and the same image runs in every environment. There are **no `NEXT_PUBLIC_*` variables**, so nothing is baked into the client bundle. `APP_ENV` (deployment) is separate from `NODE_ENV` (build mode). The timezone and currency are code constants (`src/shared/policy.ts`), not env.

```ts
import 'server-only';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    APP_VERSION: z.string().min(1).default('dev'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.url().refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgres URL'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    DEMO_MODE: bool.default(false),
    RECEIPT_STORAGE_DRIVER: z.enum(['s3', 'fs', 'memory']).default('s3'),
    RECEIPT_FS_DIR: z.string().default('./.data/receipts'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3).max(63).default('receipts'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(8).optional(),
    EXPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500), // tests use 3 to cross batch boundaries
    SEED_ON_START: bool.default(false),
    SEED_DEMO_PASSWORD: z.string().min(8).optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (key: string, message: string) => ctx.addIssue({ code: 'custom', path: [key], message });
    if (e.RECEIPT_STORAGE_DRIVER === 's3')
      for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)
        if (!e[k]) fail(k, 'required when RECEIPT_STORAGE_DRIVER=s3');
    if (e.APP_ENV === 'staging' || e.APP_ENV === 'production') {        // RT-m7: demo data never leaks out
      if (e.SEED_ON_START) fail('SEED_ON_START', 'must be false in staging/production');
      if (e.DEMO_MODE) fail('DEMO_MODE', 'must be false in staging/production');
      if (e.SEED_DEMO_PASSWORD !== undefined) fail('SEED_DEMO_PASSWORD', 'must be absent in staging/production');
      if (!e.APP_BASE_URL.startsWith('https://')) fail('APP_BASE_URL', 'must be https in staging/production');
      if (e.RECEIPT_STORAGE_DRIVER === 'memory') fail('RECEIPT_STORAGE_DRIVER', 'memory loses evidence on restart');
    }
  });

export type Env = z.infer<typeof EnvSchema>;
let cached: Readonly<Env> | undefined;

/** Importing this module never throws, so `next build` works with zero env. */
export function env(): Readonly<Env> {
  if (cached) return cached;
  const r = EnvSchema.safeParse(process.env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'); // names only, never values
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return (cached = Object.freeze(r.data));
}

/** D-34: owner/superuser material must never reach the app process. */
export const FORBIDDEN_IN_APP = ['MIGRATE_DATABASE_URL', 'SHADOW_DATABASE_URL', 'POSTGRES_PASSWORD',
  'DB_OWNER_PASSWORD', 'DB_APP_PASSWORD', 'SEED_DEMO_PASSWORD'] as const;
export const forbiddenEnvPresent = (src: NodeJS.ProcessEnv = process.env) =>
  FORBIDDEN_IN_APP.filter((k) => (src[k] ?? '') !== '');
```

Tests: TC-U11 `env.test.ts`: "invalid env makes env() throw with the variable name" · "staging and production reject SEED_ON_START=true, DEMO_MODE=true or a SEED_DEMO_PASSWORD" · "the forbidden owner and superuser variables are detected in production mode".

### 9.2 `src/instrumentation.ts`: boot checks, fail fast

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { env, forbiddenEnvPresent } = await import('@/server/env');
    const e = env();                                            // 1. config is valid
    if (e.NODE_ENV === 'production') {
      const leaked = forbiddenEnvPresent();                     // 2. no owner/superuser material in the app
      if (leaked.length) throw new Error(`Refusing to boot, forbidden variables set: ${leaked.join(', ')}`);
    }
    const { assertRuntimeRole } = await import('@/server/auth/runtime-role');
    await assertRuntimeRole();                                  // 3. connected role is least-privilege
    const { assertPolicyLoadsWellFormed } = await import('@/server/routing/policy');
    await assertPolicyLoadsWellFormed();                        // 4. tier rows pass assertPolicyWellFormed (D-19); added in P3
    const { logger } = await import('@/server/logging/logger');
    logger.info({ event: 'app.boot', version: e.APP_VERSION, appEnv: e.APP_ENV }, 'server starting');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);                                            // container exits non-zero: visible in `docker compose ps`
  }
}
```

Step 4 lands in P3 with the tiers table. `assertPolicyLoadsWellFormed()` lives in `src/server/routing/policy.ts`: it reads `tiersRepo.listAll()` as `expense_app` and passes the rows to `assertPolicyWellFormed`. It can pass in every environment because `release` runs `seedReference()` on every boot (§10.3, D-45).

`assertRuntimeRole()` runs this through `src/server/db/introspection.ts` (`readRoleAttributes()`; the same module has `countDisabledTriggers()`, `ping()` and `readinessProbe()` for the ready route) and exits if any column is true:

```sql
SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
       EXISTS (SELECT 1 FROM pg_class c
               WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owns_relations,
       pg_has_role(current_user, 'expense_owner', 'MEMBER')                          AS member_of_owner
FROM pg_roles r
WHERE r.rolname = current_user;
```

P0 verified it: started with owner credentials, the app exits 1. By design, `pnpm start` on the host refuses to boot while the host `.env` holds owner variables. Production-mode runs go through compose; `pnpm dev` (`NODE_ENV=development`) is unaffected. Test: TC-I06 › "assertRuntimeRole rejects the owner role and accepts expense_app".

### 9.3 `.env.example` (complete; `cp .env.example .env` is the only manual step)

One `.env` feeds **compose interpolation** and **host-side commands** (`pnpm dev`, `prisma`, scripts, Playwright). No compose service reads it as an `env_file`.

```dotenv
# ─────────────────────────────────────────────────────────────────────────────
# Expense Claims — LOCAL DEMO values. Copy to .env:  cp .env.example .env
# This file is read by docker compose (interpolation only) and by host commands.
# No container receives it wholesale: compose.yaml hands each service an explicit list.
# Keep DB passwords URL-safe (letters, digits, '-').
# ─────────────────────────────────────────────────────────────────────────────

# --- App runtime ---
APP_ENV=local                      # local | test | staging | production  (NODE_ENV is set by Next/Docker)
APP_BASE_URL=http://localhost:3000 # https in staging/production; decides the session cookie name
APP_PORT=3000                      # published on 127.0.0.1 only
APP_VERSION=dev
LOG_LEVEL=info
NEXT_TELEMETRY_DISABLED=1
DEMO_MODE=true                     # login page lists the demo accounts; must be false outside local
SESSION_IDLE_TIMEOUT_MINUTES=60
SESSION_ABSOLUTE_TIMEOUT_HOURS=12

# --- Runtime DB connection (role expense_app: DML only, owns nothing) ---
# Host value for `pnpm dev`. Compose builds the app's own URL with host `postgres`.
# Password must match DB_APP_PASSWORD below.
DATABASE_URL=postgresql://expense_app:local-app-pw-change-me@localhost:5432/expense_claims
DB_POOL_MAX=10

# --- PostgreSQL container (superuser: used ONLY by the postgres image and 01-roles.sh) ---
POSTGRES_DB=expense_claims
POSTGRES_USER=postgres
POSTGRES_PASSWORD=local-superuser-pw-change-me
POSTGRES_HOST_PORT=5432            # published on 127.0.0.1 only

# --- Role passwords (01-roles.sh creates expense_owner / expense_app on first boot) ---
DB_OWNER_PASSWORD=local-owner-pw-change-me
DB_APP_PASSWORD=local-app-pw-change-me

# --- Owner URL: migrations, seed, owner scripts. NEVER given to the app container ---
# Host value for the prisma CLI. Compose builds the migrate job's URL with host `postgres`.
# Password must match DB_OWNER_PASSWORD above.
MIGRATE_DATABASE_URL=postgresql://expense_owner:local-owner-pw-change-me@localhost:5432/expense_claims
# SHADOW_DATABASE_URL=             # optional: `prisma migrate dev` creates its own (owner has CREATEDB locally)

# --- Receipts / object storage (S3 API; local = SeaweedFS) ---
RECEIPT_STORAGE_DRIVER=s3          # s3 | fs | memory   (fs = P6 storage-gate fallback, §11.3; memory = tests only)
RECEIPT_FS_DIR=./.data/receipts    # fs driver only
S3_ENDPOINT=http://localhost:8333  # host value; compose uses http://objectstore:8333
S3_REGION=us-east-1
S3_BUCKET=receipts
S3_ACCESS_KEY_ID=local-demo-access-key
S3_SECRET_ACCESS_KEY=local-demo-secret-key-change-me   # SeaweedFS runs UNAUTHENTICATED without both keys
S3_HOST_PORT=8333                  # published on 127.0.0.1 only

# --- Finance export ---
EXPORT_BATCH_SIZE=500

# --- Seeding (local demo only; refused in staging/production) ---
SEED_ON_START=true                 # cast + demo claims when the users table is empty (reference data is seeded on every release)
SEED_DEMO_PASSWORD=DemoOnly!2026   # password for every @acme.test demo account

# --- E2E (host only) ---
E2E_BASE_URL=http://localhost:3000

# --- Perf evidence (host only; owner URL to the separate expense_perf database, P7) ---
PERF_DATABASE_URL=postgresql://expense_owner:local-owner-pw-change-me@localhost:5432/expense_perf

# --- OPTIONAL (buffer only) ---
# S3_PUBLIC_ENDPOINT=http://localhost:8333   RECEIPT_UPLOAD_URL_TTL_SECONDS=120   RECEIPT_DOWNLOAD_URL_TTL_SECONDS=60
# EXPORT_MAX_CONCURRENT=2   LOGIN_RATE_LIMIT_IP=20   LOGIN_RATE_LIMIT_ACCOUNT=5
# OTEL_ENABLED=false   OTEL_SERVICE_NAME=expense-claims   OTEL_EXPORTER_OTLP_ENDPOINT=
```

Role names `expense_owner` and `expense_app` are fixed constants (the triggers reference `'expense_app'`), not env. Host-only variables that are deliberately **not** in `.env.example`: `TEST_PG_SUPERUSER_URL` (external-DB mode of the integration harness, §4 trap 22) and `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` (the user's consent for an AI agent to run `prisma migrate reset`, §4 trap 31). Removed for good: `AUTH_SECRET`, `AUTH_*`, `APP_TIMEZONE`, `BUSINESS_TIMEZONE`, `APP_CURRENCY`, `DEFAULT_CURRENCY`, `DATABASE_URL_MIGRATE`, `DATABASE_OWNER_URL`, `APP_URL`, `TEST_DATABASE_URL`, `DB_OWNER_USER`, `DB_APP_USER`.

### 9.4 Which process receives which variable (app vs migrate separation)

| Variable | postgres | objectstore | migrate | app | host |
|---|---|---|---|---|---|
| `POSTGRES_DB`, `POSTGRES_USER` | ✓ | | (in URL) | (in URL) | |
| `POSTGRES_PASSWORD` | ✓ **only** | | | **forbidden** | |
| `DB_OWNER_PASSWORD` | ✓ (initdb) | | (inside `MIGRATE_DATABASE_URL`) | **forbidden** | |
| `DB_APP_PASSWORD` | ✓ (initdb) | | | inside `DATABASE_URL` only; the variable itself is **forbidden** | |
| `MIGRATE_DATABASE_URL` | | | ✓ (host `postgres`) | **forbidden** | ✓ prisma CLI, owner scripts |
| `SHADOW_DATABASE_URL` | | | | **forbidden** | ✓ optional |
| `DATABASE_URL` | | | (set to the owner URL inside the seed process only) | ✓ `expense_app`, host `postgres` | ✓ `pnpm dev` |
| `SEED_ON_START`, `SEED_DEMO_PASSWORD` | | | ✓ | `SEED_DEMO_PASSWORD` **forbidden** | ✓ (`SEED_DEMO_PASSWORD` for Playwright) |
| `S3_*` credentials | | ✓ as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | ✓ (ensure-bucket) | ✓ | ✓ |
| `APP_BASE_URL`, `DEMO_MODE`, `SESSION_*`, `DB_POOL_MAX`, `RECEIPT_*`, `EXPORT_BATCH_SIZE`, `APP_VERSION`, `NEXT_TELEMETRY_DISABLED` | | | | ✓ | ✓ |
| `APP_ENV`, `LOG_LEVEL` | | | ✓ | ✓ | ✓ |
| `*_HOST_PORT`, `APP_PORT` | publish | publish | | publish | |
| `E2E_BASE_URL` | | | | | ✓ |
| `PERF_DATABASE_URL` | | | | | ✓ `perf:seed`, `perf:explain` |
| `RECEIPT_STORAGE_DRIVER` | | | ✓ (`ensure-bucket` is a no-op for `fs`) | ✓ | ✓ |

"Forbidden" means the app exits on boot when `NODE_ENV=production` and the variable is set (§9.2). TC-E06 › "a clean docker compose up is healthy and the app container holds no owner or superuser credentials" checks `docker compose exec app env`.

### 9.5 Key configuration files

**`next.config.ts`**

```ts
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  cacheComponents: false,   // explicit: create-next-app@16.4 enables it; all data is per-user (D-01)
  reactCompiler: false,     // D-50
  turbopack: {              // Tailwind 4 as the 16.4 template wires it: no postcss.config.mjs (§4 trap 27)
    rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } },
  },
  async headers() {         // build-time: static values only
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] }, // defineRoute sets it too
    ];
  },
};
export default nextConfig;
```

**`prisma.config.ts` and the generator**

```ts
import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'prisma/config';

loadEnvConfig(process.cwd()); // same .env precedence as Next; real env (compose, CI) always wins

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx --conditions=react-server prisma/seed.ts' },
  datasource: {
    // The CLI runs as the OWNER. process.env (not env()) so `prisma generate` works in a Docker build with no URL.
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    // Optional: `migrate dev` creates its own shadow DB (the owner has CREATEDB). An empty value is a P1013 error.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
```

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"   // import from '@/generated/prisma/client'
  runtime         = "nodejs"
  moduleFormat    = "esm"
  previewFeatures = ["partialIndexes"]          // fallback: hand-written SQL partial indexes (D-37)
}

datasource db {
  provider = "postgresql"                       // URL lives in prisma.config.ts (Prisma 7)
}
// ids: id String @id @default(dbgenerated("uuidv7()")) @db.Uuid   — models in 03
```

Migration workflow: `pnpm db:migrate:dev --create-only --name <name>` → hand-append SQL (functions, triggers, CHECKs, views, grants) → `pnpm db:migrate:dev`. Never edit an applied migration; never `prisma db push` or `db pull` (they skip the hand-written SQL). **Drift rule** (D-37, one rule for local, P0 exit and CI): `pnpm db:deploy && pnpm db:diff-check`, with no shadow DB to pre-create; P0 also checks that `prisma migrate dev --create-only` run twice produces empty migrations. Both passed in P0 ("No difference detected"). Migration list in [03](./03-data-model-and-integrity.md).

**`prisma/seed.ts` runs as the owner.** Its first lines are `import nextEnv from '@next/env'; nextEnv.loadEnvConfig(process.cwd())` (default import: the named import fails under `tsx` here, §4 trap 26) and `process.env.DATABASE_URL = process.env.MIGRATE_DATABASE_URL`, and only then does it dynamically import the services. That way the real services (and their `getDb()`) connect as `expense_owner`, but only inside the seed process, so `SeedClock` timestamps are kept (D-23, D-45). It has two parts (D-45): `seedReference()` (departments, categories, tiers T1–T3, L4 only if deepa exists; `INSERT … ON CONFLICT (code) DO NOTHING`) runs on **every** `release` in every environment; the cast and C01–C12 run only when `SEED_ON_START=true` and `users` is empty, and that part refuses to run when `APP_ENV ∈ {staging, production}`.

**`src/server/db/client.ts` and `tx.ts`**

```ts
import 'server-only';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/server/env';

const g = globalThis as unknown as { __db?: PrismaClient };

export function getDb(): PrismaClient {                    // lazy; one pool per process; survives dev HMR
  if (g.__db) return g.__db;
  const e = env();
  const adapter = new PrismaPg({
    connectionString: e.DATABASE_URL, max: e.DB_POOL_MAX,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, application_name: 'expense-claims-app',
  });
  // Tests only: emit (never log) query events so TC-I17 can capture the SQL it sends (07 §8).
  const log = e.APP_ENV === 'test' ? [{ emit: 'event' as const, level: 'query' as const }] : undefined;
  return (g.__db = new PrismaClient({ adapter, log }));
}
// statement_timeout 15s, lock_timeout 5s, idle_in_transaction_session_timeout 30s are ROLE settings (01-roles.sh),
// so no client configuration can loosen them by accident.
```

```ts
// src/server/db/tx.ts — the only way services open a transaction (contract; behaviour in 02)
export type Tx = Prisma.TransactionClient;
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
// READ COMMITTED, maxWait 5_000, timeout 10_000. Retries 40001 / 40P01 / P2034 up to 2 times with jitter,
// then AppError CONFLICT { retryable: true }. 55P03 (lock_timeout) → CONFLICT. No network I/O inside fn.
```

**`src/proxy.ts`** (Next 16; Node runtime; UX only)

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { sessionCookieName } from '@/server/auth/cookie';
import { PUBLIC_PAGES } from '@/server/http/public-routes';   // same module as PUBLIC_ROUTES
import { env } from '@/server/env';

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PAGES.includes(pathname)) return NextResponse.next();
  if (req.cookies.has(sessionCookieName(env().APP_BASE_URL))) return NextResponse.next(); // presence only
  const login = new URL('/login', req.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
```

Deleting this file changes nothing about API security. The `(app)/layout.tsx` `getActor()` check and every handler's own authentication stay in place ([04](./04-security-and-api.md)).

**`tsconfig.json`**

```jsonc
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["dom", "dom.iterable", "es2023"],
    "module": "esnext", "moduleResolution": "bundler",
    "types": ["node"],                      // TS 6 default is [] → `process` would be unknown
    "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true, "useUnknownInCatchVariables": true,
    "isolatedModules": true, "esModuleInterop": true, "resolveJsonModule": true,
    "skipLibCheck": true, "noEmit": true, "incremental": true, "jsx": "react-jsx",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }         // the only alias; no baseUrl (deprecated in TS 6)
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.mts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
  "exclude": ["node_modules", ".next", "coverage", ".vitest", "playwright-report"]
}
```

`exactOptionalPropertyTypes` stays off: it fights Prisma input types and RHF defaults for little gain in two weeks.

**`pnpm-workspace.yaml`** (settings only; single package)

```yaml
onlyBuiltDependencies:        # the only packages allowed to run install scripts
  - '@prisma/engines'         # downloads the schema-engine that `prisma migrate` needs
  - prisma
  - esbuild                   # tsx / vite
  - unrs-resolver             # eslint import resolver
ignoredBuiltDependencies:     # confirmed in P0 from pnpm's "Ignored build scripts" warning (`pnpm approve-builds`)
  - sharp                     # Next image optimisation is not used
  - cpu-features              # optional ssh2 speed-up (testcontainers)
  - ssh2
  - protobufjs                # postinstall is only a version check
# OPTIONAL (BUF): minimumReleaseAge: 4320 with minimumReleaseAgeExclude: [next, '@next/*', eslint-config-next]
```

**`vitest.config.mts`** (structure only; harness behaviour in [07](./07-testing.md))

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';                 // component project, from P2
import { fileURLToPath } from 'node:url';

const emptyModule = fileURLToPath(new URL('./tests/helpers/empty-module.ts', import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true,                          // Vite 8 resolves `@/*` itself (as built in P0)
             alias: { 'server-only': emptyModule } },      // server-only throws outside react-server
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.int.test.ts'], environment: 'node',
          globalSetup: ['tests/helpers/global-setup.ts'], setupFiles: ['tests/helpers/integration-setup.ts'],
          fileParallelism: false,
          sequence: { hooks: 'stack' },                    // after-hooks run in reverse (07 §3.2)
          testTimeout: 30_000, hookTimeout: 180_000 } },
      { extends: true, plugins: [react()], test: { name: 'component', include: ['tests/component/**/*.test.tsx'],
          environment: 'jsdom', env: { TZ: 'America/Los_Angeles' } } },
    ],
  },
});
```

---

## 10. Docker

### 10.1 `Dockerfile`: multi-stage, standalone, non-root

Targets: `base → deps → build → runner | tools`. The **runner** serves traffic and holds no CLI, devDependencies, source or `.env`. The **tools** image runs one-shot jobs and never serves traffic.

```dockerfile
# syntax=docker/dockerfile:1
# Digest-pinned in P0 (multi-arch index); bump tag and digest together.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

# ── base ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ── deps: all dependencies (incl. dev) with Linux-native binaries ────────────
FROM base AS deps
# openssl + CA certs: Prisma schema-engine platform detection and TLS to managed Postgres
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ── build: Next standalone (needs ZERO env) ──────────────────────────────────
FROM deps AS build
COPY . .
# public/ may be missing on a clean clone (git doesn't track empty dirs); the runner COPYs it.
RUN mkdir -p public \
 && pnpm db:generate && pnpm build \
 && test -f .next/standalone/server.js            # fail fast if standalone output regresses

# ── tools: one-shot jobs (migrate, seed, ensure-bucket). Never serves traffic. ─
FROM deps AS tools
COPY . .
RUN pnpm db:generate && chmod +x docker/tools/entrypoint.sh
# CHECKPOINT_DISABLE: no Prisma CLI update/telemetry call from a release job
ENV NODE_ENV=production PATH=/app/node_modules/.bin:$PATH CHECKPOINT_DISABLE=1
USER node
ENTRYPOINT ["/app/docker/tools/entrypoint.sh"]
CMD ["release"]

# ── runner: minimal production image ─────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
ARG APP_VERSION=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP_VERSION=${APP_VERSION}
WORKDIR /app
RUN mkdir .next && chown node:node .next
# FS storage fallback only (§11.3): RUN mkdir -p .next .data/receipts && chown -R node:node .next .data
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
```

Why each line matters:
- **`HOSTNAME=0.0.0.0`**: Docker sets `HOSTNAME` to the container id, and the standalone server would otherwise bind only to that.
- **`public/` and `.next/static` are copied explicitly** because standalone output omits them. The build stage creates `public/` first, because git doesn't track an empty directory and the COPY would fail on a clean clone.
- **Digest-pinned base image**: the tag documents the version, the digest makes the build reproducible. Compose and Testcontainers pin the postgres image the same way (§3.3).
- **The healthcheck uses Node's global `fetch`** because the slim image has no curl. It probes readiness, which checks the DB and that the integrity triggers are enabled ([06](./06-cross-cutting.md)).
- **Non-root `node` (uid 1000)**. Next standalone handles SIGTERM itself, so `NEXT_MANUAL_SIG_HANDLE` is not set.
- **Expected size**: runner ~200–250 MB. The tools image is large (full `node_modules`), which is acceptable for a job image.

### 10.2 `.dockerignore`

```text
.git
.github
node_modules
.next
.env
.env.*
coverage
.vitest
playwright-report
test-results
tests
e2e
load
docs
src/generated
*.log
```

`.env*` never enters the build context, so the image is identical in every environment and holds no secrets.

### 10.3 `docker/tools/entrypoint.sh`

```sh
#!/bin/sh
# One-shot jobs for the `migrate` compose service (and an Azure Container Apps Job in production).
set -eu

migrate()       { prisma migrate deploy; }               # MIGRATE_DATABASE_URL via prisma.config.ts
seed()          { prisma db seed; }                      # seed.ts rebinds DATABASE_URL to the owner URL; seedReference() always,
                                                         # cast + demo claims only if SEED_ON_START=true and users is empty (D-45)
ensure_bucket() {                                        # HeadBucket with retry/backoff (≤ 60 s), CreateBucket if missing
  if [ "${RECEIPT_STORAGE_DRIVER:-s3}" = "fs" ]; then echo "[tools] ensure-bucket: skipped (fs driver)"; return 0; fi
  tsx scripts/ensure-bucket.ts
}

case "${1:-release}" in
  migrate)       migrate ;;
  seed)          seed ;;
  ensure-bucket) ensure_bucket ;;
  release)       migrate; ensure_bucket; seed ;;         # bucket first: the demo seed uploads C04's receipt (P8)
  *) exec "$@" ;;                                        # e.g. `docker compose run --rm migrate sh`
esac
```

`release` is the release step: migrate → ensure-bucket (a no-op for the `fs` driver) → seed (reference data always, so new tiers or categories reach an existing volume and staging/production; the cast and demo claims only if `SEED_ON_START=true` and `users` is empty). As built in P0, `seed` and `ensure-bucket` are logged no-op stubs and `release` calls `seed` only when `SEED_ON_START=true`; P1 makes the seed real and unconditional, P6 adds `ensure_bucket` to `release`, and P8 moves it before the seed because the demo seed uploads one receipt on C04 through the real receipts service. Bucket creation lives here, not in a separate `storage-init` service, because one one-shot job is enough.

### 10.4 `docker/postgres/initdb/01-roles.sh`

This runs once as the image superuser on an empty volume. Testcontainers mounts the same script, so tests get the same roles and REVOKEs as compose and production. Table grants live in migrations, explicitly per table and with **no `ALTER DEFAULT PRIVILEGES`** ([03](./03-data-model-and-integrity.md), privilege matrix).

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${DB_OWNER_PASSWORD:?}" "${DB_APP_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
-- expense_owner: owns DB, schema and every object; used ONLY by the migrate job and host prisma CLI
CREATE ROLE expense_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE NOBYPASSRLS CREATEDB; -- CREATEDB: local shadow DB
-- expense_app: runtime; owns nothing; DML grants come from migrations
CREATE ROLE expense_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE expense_app SET statement_timeout = '15s';
ALTER ROLE expense_app SET lock_timeout = '5s';
ALTER ROLE expense_app SET idle_in_transaction_session_timeout = '30s';

ALTER DATABASE :"db" OWNER TO expense_owner;
ALTER DATABASE :"db" SET timezone TO 'UTC';
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;                -- drops PUBLIC's CONNECT + TEMPORARY: no temp tables shadowing `claims` (RT-M10)
GRANT CONNECT ON DATABASE :"db" TO expense_app;
ALTER SCHEMA public OWNER TO expense_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;                 -- no CREATE (and no implicit USAGE) for anyone else
GRANT USAGE ON SCHEMA public TO expense_app;
-- These are the exact statements verified by the SQL proof (03 §16.1).
SQL
```

Commit it with the executable bit set (`git update-index --chmod=+x`). **This file is the one to copy verbatim.** [03 §16.1](./03-data-model-and-integrity.md#161-bootstrap-01-rolessh-statements-not-a-migration) is the statement list it implements; its `CREATE DATABASE … ; \connect …` lines apply only to `expense_perf`, because the postgres image has already created `POSTGRES_DB` before initdb scripts run (with `ON_ERROR_STOP` a `CREATE DATABASE expense_claims` would fail and postgres would never become healthy).

---

## 11. Compose

### 11.1 `compose.yaml`

The services are `postgres`, `objectstore`, `migrate` and `app`, plus `k6` under profile `load` (OPTIONAL). **No service uses `env_file`.** Every service lists exactly the variables it needs. All published ports bind to `127.0.0.1`.

```yaml
name: expense-claims

services:
  postgres:
    image: postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336   # same digest as Testcontainers
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-expense_claims}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Run cp .env.example .env}
      DB_OWNER_PASSWORD: ${DB_OWNER_PASSWORD:?}
      DB_APP_PASSWORD: ${DB_APP_PASSWORD:?}
    volumes:
      - pgdata:/var/lib/postgresql                      # PG 18 layout, NOT /var/lib/postgresql/data
      - ./docker/postgres/initdb:/docker-entrypoint-initdb.d:ro
    ports: ["127.0.0.1:${POSTGRES_HOST_PORT:-5432}:5432"]
    healthcheck:
      # TCP, not the socket: initdb's temporary server listens on the socket only, so a socket probe
      # can report healthy before 01-roles.sh has finished (§4 trap 29).
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 5432 -U \"$${POSTGRES_USER}\" -d \"$${POSTGRES_DB}\""]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s

  objectstore:                                          # added in P6
    image: chrislusf/seaweedfs:4.48
    command: ["mini", "-dir=/data"]                     # master + volume + filer + S3 (:8333) in one process
    environment:                                        # BOTH required, else S3 runs unauthenticated
      AWS_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?}
      AWS_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?}
    volumes: ["objectstore:/data"]
    ports: ["127.0.0.1:${S3_HOST_PORT:-8333}:8333"]
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 8333 || exit 1"]   # port is up; ensure-bucket retries until S3 answers
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 10s

  migrate:                                              # one-shot release job
    build: { context: ., target: tools }
    image: expense-claims-tools:local
    command: ["release"]
    environment:
      APP_ENV: ${APP_ENV:-local}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      MIGRATE_DATABASE_URL: postgresql://expense_owner:${DB_OWNER_PASSWORD:?}@postgres:5432/${POSTGRES_DB:-expense_claims}
      SEED_ON_START: ${SEED_ON_START:-false}
      SEED_DEMO_PASSWORD: ${SEED_DEMO_PASSWORD:-}
      RECEIPT_STORAGE_DRIVER: ${RECEIPT_STORAGE_DRIVER:-s3}   # P6: ensure-bucket is a no-op for fs
      S3_ENDPOINT: http://objectstore:8333
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_BUCKET: ${S3_BUCKET:-receipts}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?}
    depends_on:
      postgres: { condition: service_healthy }
      objectstore: { condition: service_healthy }       # added in P6; dropped under the FS fallback (§11.3)
    restart: "no"

  app:
    build:
      context: .
      target: runner
      args: { APP_VERSION: "${APP_VERSION:-dev}" }
    image: expense-claims-app:local
    environment:                                        # NO owner URL, NO superuser or role passwords
      APP_ENV: ${APP_ENV:-local}
      APP_BASE_URL: ${APP_BASE_URL:-http://localhost:3000}
      APP_VERSION: ${APP_VERSION:-dev}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      DATABASE_URL: postgresql://expense_app:${DB_APP_PASSWORD:?}@postgres:5432/${POSTGRES_DB:-expense_claims}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      SESSION_IDLE_TIMEOUT_MINUTES: ${SESSION_IDLE_TIMEOUT_MINUTES:-60}
      SESSION_ABSOLUTE_TIMEOUT_HOURS: ${SESSION_ABSOLUTE_TIMEOUT_HOURS:-12}
      DEMO_MODE: ${DEMO_MODE:-false}
      RECEIPT_STORAGE_DRIVER: ${RECEIPT_STORAGE_DRIVER:-s3}
      S3_ENDPOINT: http://objectstore:8333
      S3_REGION: ${S3_REGION:-us-east-1}
      S3_BUCKET: ${S3_BUCKET:-receipts}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?}
      EXPORT_BATCH_SIZE: ${EXPORT_BATCH_SIZE:-500}
      NEXT_TELEMETRY_DISABLED: "1"
    ports: ["127.0.0.1:${APP_PORT:-3000}:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 30s
    init: true                                          # PID 1 forwards signals
    stop_grace_period: 20s                              # in-flight requests finish; verified in P8

  k6:                                                   # OPTIONAL: docker compose --profile load run --rm k6 run /scripts/export.k6.js
    image: grafana/k6:2.3.0
    profiles: ["load"]
    volumes: ["./load:/scripts:ro", "./docs/perf:/out"]
    environment: { BASE_URL: "http://app:3000" }
    depends_on:
      app: { condition: service_healthy }

volumes:
  pgdata: {}
  objectstore: {}
```

There is no `restart:` policy on `app`. A misconfigured app exits non-zero and `--wait` fails fast, instead of looping. In production, restarts are the orchestrator's job. `read_only` / `cap_drop` hardening is OPTIONAL because it can break Next's cache directories.

### 11.2 Startup sequence

```mermaid
flowchart LR
    PG[("postgres<br/>postgres:18.6-trixie<br/>first boot runs 01-roles.sh")]
    OS[("objectstore<br/>chrislusf/seaweedfs:4.48<br/>weed mini")]
    MIG["migrate (tools image)<br/>release: migrate deploy, ensure-bucket, seed"]
    APP["app (runner image)<br/>node server.js"]
    PG -->|service_healthy| MIG
    OS -->|service_healthy| MIG
    MIG -->|service_completed_successfully| APP
```

| Step | What happens | Gate |
|---|---|---|
| 1 | `postgres` initialises an empty volume. The image creates `expense_claims` and runs `01-roles.sh` (roles, ownership, REVOKEs) | healthcheck `pg_isready -h 127.0.0.1` over TCP, which can only succeed once initdb has finished |
| 1′ | `objectstore` starts in parallel with both admin keys | healthcheck `nc -z :8333` |
| 2 | `migrate` runs `release`: `prisma migrate deploy` as `expense_owner` → ensure-bucket (retries until S3 answers; no-op for `fs`) → seed as owner (`seedReference()` always; cast + demo claims, incl. C04's receipt, if `SEED_ON_START=true` and `users` is empty) | exits 0 → `service_completed_successfully`; any failure stops the chain |
| 3 | `app` boots: `env()` valid → no forbidden variables → `assertRuntimeRole()` → tier policy well formed (`assertPolicyLoadsWellFormed()`, from P3) → listens on :3000 | healthcheck `/api/health/ready`: DB `SELECT 1` within 1 s and zero disabled integrity triggers; storage reported but never failing readiness |
| 4 | `docker compose up --build --wait` returns 0 | all long-running services healthy, `migrate` Exited (0) |

There are no sleep or wait-for scripts: ordering comes only from `depends_on` conditions. This is why migrating is a release step. It maps 1:1 to an Azure Container Apps Job that runs before a new revision.

### 11.3 Developer flows

| Flow | Commands |
|---|---|
| **Full stack (demo, review, e2e)** | `cp .env.example .env && docker compose up --build --wait` → http://localhost:3000 (`pnpm compose:up`) |
| **Clean reset (P0 and P8 exit check; also after extending the seed in P3–P5)** | `docker compose down -v && cp .env.example .env && docker compose up --build --wait` |
| **Inner loop (hot reload)** | `docker compose up -d --wait postgres objectstore && docker compose run --rm migrate` then `pnpm dev` (or `pnpm dev:pretty`) on the host with the `.env` localhost URLs |
| **New migration** | `pnpm db:migrate:dev --create-only --name <name>` → append SQL → `pnpm db:migrate:dev`; then a second `--create-only` must produce an empty migration (delete it) |
| **Drift check (D-37)** | `pnpm db:deploy && pnpm db:diff-check` (no shadow DB to pre-create) |
| **Reset the dev DB** | `pnpm db:reset` (owner; drops schema `public`, re-applies every migration, seeds). Prisma 7.10 refuses it under an AI agent unless the user consents (`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, set by the user); an agent asks the user to run it or to give that consent, and never sets the variable itself |
| **Re-run initdb** | `docker compose down -v` (initdb runs only on an empty volume) |
| **Storage fallback (decided at the P6 storage gate)** | `.env`: `RECEIPT_STORAGE_DRIVER=fs`. Compose: add `RECEIPT_FS_DIR: /app/.data/receipts` and volume `receipts:/app/.data/receipts` to `app`, plus top-level `receipts: {}`; drop `objectstore` from `migrate.depends_on`; pass `RECEIPT_STORAGE_DRIVER` to `migrate` so `ensure_bucket` is a no-op; **and remove the `objectstore` service and volume (or move it under `profiles: ["s3"]`)**, so a failing SeaweedFS can't break `up --wait`. Dockerfile runner: `RUN mkdir -p .next .data/receipts && chown -R node:node .next .data`, otherwise the named volume is root-owned and uid 1000 gets EACCES. Only TC-E06's service list changes |
| **Graceful shutdown check (P8)** | `docker compose stop app` exits within `stop_grace_period`; an in-flight export ends as a failed download ([06](./06-cross-cutting.md)) |

---

## 12. `package.json`

```jsonc
{
  "name": "expense-claims",
  "private": true,
  "type": "module",                          // Prisma 7 is ESM-first; Next fixed standalone + type:module
  "packageManager": "pnpm@10.34.6",
  "engines": { "node": ">=24.21.0 <25" },
  "scripts": {
    "dev": "next dev",
    "dev:pretty": "next dev | pino-pretty",
    "build": "next build",
    "start": "next start",                   // host smoke only; refuses to boot while .env holds owner vars (by design)
    "typecheck": "next typegen && tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",

    "db:generate": "prisma generate",
    "db:migrate:dev": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "prisma db seed",
    "db:reset": "prisma migrate reset --force && prisma db seed",
    "db:diff-check": "prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",

    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:component": "vitest run --project component",
    "test:e2e": "playwright test",
    "verify": "pnpm db:generate && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:unit && pnpm test:component && pnpm test:int",

    "verify:integrity": "tsx --conditions=react-server scripts/verify-integrity.ts",        // imports server-only modules (§4 trap 18)
    "policy:activate-tier": "tsx --conditions=react-server scripts/policy-activate-tier.ts",
    "perf:seed": "tsx --conditions=react-server scripts/perf/seed-perf.ts",
    "perf:explain": "tsx --conditions=react-server scripts/perf/explain.ts",

    "compose:up": "docker compose up --build --wait",
    "compose:down": "docker compose down",
    "compose:reset": "docker compose down -v"
  }
}
```

| Script | What to know |
|---|---|
| `typecheck` | `next typegen` first, so `RouteContext<'/api/v1/claims/[claimId]'>` types exist |
| `db:*` | Always run as the **owner** (`MIGRATE_DATABASE_URL` wins in `prisma.config.ts`). `db:reset` seeds explicitly because Prisma 7 no longer does; Prisma 7.10 refuses `migrate reset` under an AI agent without the user's consent (§4 trap 31) |
| `db:diff-check` | After `db:deploy`, compares the live schema with `schema.prisma`; non-zero means drift (`--from-url` was removed in v7). `pnpm db:deploy && pnpm db:diff-check` **is** the drift rule (D-37): no shadow DB |
| `verify` | The local gate, identical to CI; run it before every commit |
| `verify:integrity` | Prints `v_claim_total_drift`; must print 0 rows (live §6-5 demo) |
| `policy:activate-tier` | `pnpm policy:activate-tier L4_CFO`: owner-run tier activation, zero code change (§8). First lines: `nextEnv.loadEnvConfig(process.cwd())` (default import), then `process.env.DATABASE_URL = process.env.MIGRATE_DATABASE_URL` (exit 1 if unset; the app role has SELECT only on tiers), then dynamic-import `policy.ts`. One transaction: `SELECT` all tiers `FOR UPDATE` → set `is_active` → `assertPolicyWellFormed` → COMMIT |
| `perf:seed` / `perf:explain` | Owner via `PERF_DATABASE_URL` (core, §9.3), separate DB `expense_perf`, all triggers on, `--claims 10000` by default (spec: [07 §12.1](./07-testing.md#121-the-generator-scriptsperfseed-perfts-pnpm-perfseed)); writes `docs/perf/*.txt` |

---

## 13. CI outline (`.github/workflows/ci.yml`)

One workflow, one job, the same commands as `pnpm verify`, plus the drift rule (`pnpm db:deploy && pnpm db:diff-check`, D-37) on the compose Postgres and its roles script. It is scheduled in **P8** (moved from P1 to free that phase; cut item 6 if behind). Until then `pnpm verify` is the local gate. A draft `ci.yml` already exists from P0.

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
env: { NEXT_TELEMETRY_DISABLED: "1" }

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v7            # OPTIONAL hardening: pin every action by commit SHA
      - uses: pnpm/action-setup@v6           # reads packageManager
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm test:unit
      - run: pnpm test:component
      - run: pnpm test:int                   # Testcontainers uses the runner's Docker daemon
      - name: Schema ↔ migrations drift
        run: |
          cp .env.example .env
          docker compose up -d --wait postgres   # same initdb roles script as local
          pnpm db:deploy
          pnpm db:diff-check
```

| Class | Item |
|---|---|
| CORE | the job above; exact pins; committed lockfile; `onlyBuiltDependencies` |
| OPTIONAL (BUF) | e2e job (`cp .env.example .env && docker compose up --build --wait` → `pnpm test:e2e`, upload report + `docker compose logs`); SHA-pinned actions; Dependabot with a 7-day cooldown that ignores `prisma` ≥ 8, `typescript` ≥ 7 and `eslint` ≥ 10; Trivy image scan; husky + lint-staged; `minimumReleaseAge` |
| NOT PLANNED | GHCR publish, SBOM / provenance |

If shared runners hit Docker Hub anonymous pull limits, log in with a read-only token before `compose up`.

---

## 14. Production mapping (Azure; documentation only)

| Local | Azure equivalent | Note |
|---|---|---|
| `app` (runner image) | **Azure Container Apps** app; ingress :3000; readiness `/api/health/ready`, liveness `/api/health/live` | same image, `APP_ENV=production`, https `APP_BASE_URL` |
| `migrate` (tools image) | **Container Apps Job** run before the new revision | only identity that holds the owner secret; `SEED_ON_START=false` |
| `postgres:18.6` | **Azure Database for PostgreSQL Flexible Server** | if PG 18 isn't offered in the region, switch ids to `@default(uuid(7))`; roles script runs once as the admin |
| SeaweedFS | **Blob Storage** via an `AzureBlobReceiptStorage` adapter behind `ReceiptStorage` (or any S3 store as-is) | scoped identity, not admin keys (deferred RT-m6) |
| `.env` | **Key Vault** references + **managed identity** | images already carry no secrets |
| pino → stdout | Container Apps → **Log Analytics**; OTel → **Application Insights** (OPTIONAL) | `requestId` joins logs to `claim_events.request_id` |
| `pnpm verify:integrity` | scheduled Container Apps Job alerting on any drift row | runbook item (deferred part of RT-B3) |

---

## 15. Where these pieces land in the plan

Phase scopes are canonical in [C-24](./00-decisions-and-contracts.md#c-24-phases-and-calendar); days and dates live only in [PLAN §4–§5](../../PLAN.md#4-phase-wise-plan).

| Phase | Platform work from this doc | Exit check |
|---|---|---|
| **P0** | Docker Desktop on; `nvm install 24.21.0`; scaffold + re-pin (Tailwind via `@tailwindcss/turbopack`, no PostCSS); `cacheComponents: false`, standalone, `"type": "module"`; `prisma.config.ts` + generator; `01-roles.sh`; digest-pinned Dockerfile (runner + tools, `mkdir -p public`); compose with `postgres` (TCP healthcheck), `migrate`, `app`; health routes; `introspection.ts`; Testcontainers harness (+ `TEST_PG_SUPERUSER_URL` mode). Landed early: `eslint.config.mjs` + TC-U10, and a draft `ci.yml` | `docker compose down -v && cp .env.example .env && docker compose up --build --wait` healthy (`migrate` Exited 0, app uid 1000); image builds with no `.env`; drift rule clean and `--create-only` twice empty; TC-I00 spike green; app with owner credentials exits 1 |
| **P1** | Next OOB patch commit; `env.ts` + boot checks; seed wired into `release` (`seedReference()` unconditional) | TC-U11, TC-I06, TC-U10 green; broken `.env` → app exits 1 |
| **P3** | `assertPolicyLoadsWellFormed()` as boot step 4; `policy:activate-tier` (`--conditions=react-server`, owner URL) | clean `compose up` healthy after the tiers join `seedReference()` |
| **P6** | storage gate (absorbs the old P0 object-store probe): `objectstore` service + `ensure-bucket` in `release`, or the FS recipe in §11.3 | TC-I27 green against the chosen driver |
| **P7** | `perf:seed` (`--claims 10000`), `perf:explain`; `PERF_DATABASE_URL` in `.env.example` | `docs/perf/*.txt` committed |
| **P8** | CI workflow (§13); clean-clone rehearsal (Docker with Compose v2, ≥ 6 GB RAM, ports 3000/5432/8333 free on 127.0.0.1 or overridden in `.env`); TC-E06 stack smoke; shutdown check; ADR-0001 records the fallbacks used (none in P0) | `pnpm test:e2e` green on a fresh `compose up --wait`; CI green |
