# Expense Claims and Reimbursement: Master Build Plan

> 2-week solo POC on the "React to Full Stack 101" path. Stack: Next.js 16.4 App Router + TypeScript, PostgreSQL 18.6, Prisma 7.10, docker compose.
> Plan date: **Tue 13 Oct 2026, Day 1**. All decisions are frozen; every decision below can be revisited later through an ADR.
> **Status (Fri 16 Oct): P0–P8 are built and verified** (results and deviations under each phase in [§4](#4-phase-wise-plan)); only the CI workflow has not run yet (no GitHub remote). The BUF and optional phases remain. [§4](#4-phase-wise-plan)–[§5](#5-day-by-day-timeline-and-critical-path) is the only place that assigns phases to days.

## TL;DR

We build **one Next.js app**. Its only door to the data is a versioned REST API (`/api/v1`), and PostgreSQL itself enforces the two things this POC is graded on:

- **The claim total.** `claims.total_minor` is stored, but only Postgres statement triggers ever write it. Any other writer is rejected, and the total is checked again at COMMIT. No API call, Prisma call or raw SQL running as the app's role can make it drift from its line items, including under concurrency.
- **Visibility.** A predicate is AND-composed into the single SELECT that loads a claim. An approver who asks for a foreign claim by id gets nothing back from the database itself, so the API returns 404.

Around those two guarantees:

- A four-status lifecycle with immutable, DB-verified submission revisions.
- Approval tiers stored as data rows and materialised as approval-step rows at submit.
- An append-only audit table that the database forces services to write in the same transaction.
- Keyset-paginated lists.
- A streamed CSV export of approved claims for an IST period.
- Receipts per line item in an S3-compatible object store.
- A compose stack that boots with `cp .env.example .env && docker compose up`.

The build runs as vertical slices: **9.5 planned days plus a half-day buffer**. TC-I12, TC-I13 and the owner-scoped form of TC-I17 are green by the **end of Day 4**:

- The total cannot desync, including under concurrency (TC-I12, TC-I13).
- An approver fetching a foreign claim by id is refused at the query (owner-scoped first form by D4; routed-approver form by end of D5). TC-I17 is complete by end of D6, apart from the history and recall rows (P5) and the receipt rows (P6), which arrive with their routes.

Nothing that requirements §6 checks is ever on the cut list.

### How to read this

| Read | It holds | Read it when |
|---|---|---|
| **This file** | Decisions, invariants, the phase-wise plan, timeline, walkthrough prep, risks, traceability, learning map | First, then every morning |
| [01-architecture-and-stack.md](docs/design/01-architecture-and-stack.md) | Runtime topology, layering and import boundaries, folder layout, pinned versions, Dockerfile and compose, env variables, CI | P0, P1 |
| [02-domain-and-workflow.md](docs/design/02-domain-and-workflow.md) | Lifecycle state machine, routing and tiers, recall and resubmission, the concurrency recipe, the **audit event catalogue** | P3 to P5 |
| [03-data-model-and-integrity.md](docs/design/03-data-model-and-integrity.md) | ERD, Prisma schema, verified integrity SQL (triggers, CHECKs, view), DB roles and grants, indexes, migrations, seed | P0, P2, P3 |
| [04-security-and-api.md](docs/design/04-security-and-api.md) | Authentication, the authz matrix, scoped queries, API reference, error catalogue, validation, hardening | P1, P2, P4 |
| [05-frontend.md](docs/design/05-frontend.md) | Pages, components, data fetching, forms, money and date handling in the UI | P1 to P7 |
| [06-cross-cutting.md](docs/design/06-cross-cutting.md) | Structured logging and observability, receipts storage, finance export, health endpoints | P1, P6, P7 |
| [07-testing.md](docs/design/07-testing.md) | Test strategy, the named test catalogue (TC-…), the two sharpest tests, E2E, load test | Every phase |
| [00-decisions-and-contracts.md](docs/design/00-decisions-and-contracts.md) | The authoritative register: every decision `D-xx` (why, rejected options, CORE/OPTIONAL), every contract `C-xx` (enums, codes, routes, env, versions, seed cast), the contradiction log and the red-team ledger `RT-xx` | When a doc cites `D-xx`, `C-xx` or `RT-xx`, or two docs seem to disagree (the register wins on names and decisions; the verified SQL in 03 §16 wins on SQL, see the register's errata box) |
| [00-traceability.md](docs/design/00-traceability.md) | Every requirement line → decision → design doc → test name → phase | Before closing each phase; before the walkthrough |
| [reference/sql-proof/](docs/reference/sql-proof/README.md) | The planning-time proof: integrity SQL run on real PostgreSQL 18 (127/127), the bugs it found, recorded Prisma 7 error shapes, and a re-runnable harness | P0 (copy SQL from 03 §16; port the harness cases into TC-I00/TC-I12/TC-I13) |

During the build we also produce `README.md` (with the §6 table), eight ADRs in `docs/adr/`, and `docs/walkthrough.md`, `docs/demo-script.md`, `docs/runbook.md` and `docs/perf/*.txt` (see [§6](#6-definition-of-done-and-submission-evidence)).

---

## 1. Decisions at a glance

The IDs are stable labels that the traceability matrix in [§9](#9-requirements-traceability-matrix) refers to. Each "Why" is the sentence to say in the walkthrough.

| ID | Decision | Choice | Why | Rejected |
|---|---|---|---|---|
| D-01 | **Framework & interface** | One Next.js 16.4 App Router app. REST Route Handlers under `/api/v1` are the **only** interface (`route → service → repository → Postgres`). ESLint bans Server Actions and `'use cache'`. `output: 'standalone'`, `cacheComponents: false` | One deployable, one auth model, one set of shared Zod schemas, and exactly one door that Vitest, curl and Playwright all test | Express API + Vite SPA (two deployables); tRPC (RPC semantics, not HTTP codes); Server Actions (implicit public endpoints); Cache Components default (cross-user cache risk) |
| D-03 | Layering | `src/app/api/**/route.ts` → `src/server/services/**` → `src/server/repositories/**` → Prisma. Only repositories (and `src/server/db/**`) import Prisma, and ESLint zones enforce it. There is no unscoped `findClaimById` | The architecture becomes a build failure, not a convention | Convention only; Biome |
| D-04 | UI data fetching | Client components with TanStack Query over `/api/v1`. Server Components render only the shell (`getActor()`). Buttons come only from the server's `allowedActions`. Finance and export services self-guard with `requireRole` | One read path, and it is the tested path. A page can never show what the API would refuse | RSC reads through services; client-side role/status `if` logic |
| D-05 | **Authentication** | Hand-rolled opaque DB sessions. A 32-byte token sits in an HttpOnly cookie (`__Host-ec_session` on https, `ec_session` on http localhost) and `sha256(token)` is stored in `sessions`. argon2id via `node:crypto`. 60 min sliding idle timeout, 12 h absolute. Role and `canApprove` are read live on every request. Login returns 200 `{data:{user}}`. No `AUTH_SECRET`. Entra ID exists as ADR text only | About 150 explainable lines. Revocation is instant and roles are always current, because we hit Postgres on every request anyway | Better Auth; Auth.js v5 (credentials forces JWT); self-issued JWT sessions (no revocation) |
| D-06 | CSRF & headers | `SameSite=Lax` cookie. Origin / `Sec-Fetch-Site` check on unsafe methods and on the export GET (403 `CSRF_REJECTED`). JSON-only bodies (415). No CORS. Static security headers in `next.config.ts` | Layered defence with no token plumbing in React | Synchronizer or double-submit tokens; nonce CSP (OPTIONAL) |
| D-07 | Route wrapper | `defineRoute({ auth, roles?, params?, query?, body?, handler })`, tagged with `ROUTE_META`. Pipeline order: request id → authenticate (401) → CSRF (403) → role gate (403) → path params (404) → content type (415) → Zod (422) → service → error mapping → access log. `PUBLIC_ROUTES` = login plus the two health probes | Auth runs inside every handler (CVE-2025-29927 showed middleware can be skipped), and every route gets validation, errors and logging for free | Auth in middleware/`proxy.ts`; `authed()` / `withApi()` |
| D-08 | Roles | `users.role` ∈ {EMPLOYEE, FINANCE, ADMIN}, plus `can_approve` and `is_fallback_approver`. `CHECK (NOT (role='FINANCE' AND can_approve))`. Every user can file claims. ADMIN has no UI and no extra visibility | Segregation of duties is a row CHECK, not a runtime hope | `user_roles` join table; `roles[]` array |
| D-12 | **Claim-total strategy** | **Stored, maintained only by Postgres.** Three AFTER STATEMENT triggers on `line_items` do a full `SUM` recompute (never deltas). `claims_guard` rejects any other write (UC003). A deferred constraint trigger re-asserts `total = Σ lines` at COMMIT (UC009). The `v_claim_total_drift` view must stay empty. Strict Zod rejects a client-sent total (422 `TOTAL_IS_DERIVED`) | Routing, the queue, sorting and the export need a cheap, stable number. Putting it under DB control sends every path (API, Prisma bulk writes, raw SQL, COPY, MERGE, concurrent writers) through the same enforcement | Compute-on-read only (no index or sort, still needs a frozen number); app-maintained total; delta triggers; generated column; Prisma extension |
| D-13 | Plan B gate for the total | If spike tests (a) to (e) are not green by the **end of D2**, switch to compute-on-read: view `claims_with_totals`, plus an immutable `claim_submissions.total_minor` verified at insert. **Passed on D2 AM:** TC-I00 (a) to (e) are green, so Plan B is not needed | §4 allows either design, and a hard gate stops the core hard case from eating the schedule | No fallback |
| D-21 | **Where "approved = read-only" is enforced** | **All three layers, and the DB is the guarantee.** UI: actions hidden from `allowedActions` (cosmetic). Service: owner-scoped lock, then status check → 409 `CLAIM_LOCKED`. DB: `claims_guard` and `assert_claim_editable` (called by the line and receipt triggers) raise UC001. The app role cannot disable triggers | Every path, whether API, Prisma, raw SQL or a future bug, hits the same wall | UI-only or service-only enforcement |
| D-14 | Concurrency | READ COMMITTED. Every mutation runs in `withTx` and **first** takes an **actor-scoped** `SELECT … FOR NO KEY UPDATE` on the claim (`lockOwnedClaim`, or `lockClaimRoutedToMe` for decisions). Child-row triggers also lock the parent. 40001/40P01 are retried up to 2 times, then 409 `CONFLICT`. 55P03 (lock timeout) → 409 `CONFLICT` | The claim row is the mutex. NO KEY UPDATE conflicts with itself but not with the foreign-key KEY SHARE lock, so writers queue instead of deadlocking | `FOR UPDATE` (deadlocks); SERIALIZABLE everywhere; advisory locks; unscoped locks |
| D-27 | Line-item write contract | Exactly one write path: `PUT /api/v1/claims/:claimId` replaces the whole set in one transaction. Any incoming line `id` not on this claim → 404 `LINE_ITEM_NOT_FOUND` before anything is written. Every repository write is `(tx, actor, claimId, childId?)` | One request = one transaction = one commit-time total check, and a foreign line id can't ride in my body (IDOR) | Per-line POST/PATCH/DELETE endpoints; `update({ where: { id } })` |
| D-30 | **Receipts model** (§3.1 "your choice, document it") | **Per line item.** Optional for submission. Up to 5 per line; jpeg, png, webp or pdf; ≤ 10 MiB; magic bytes checked; sha256 stored. Upload is server-proxied multipart. Download streams through the app after the visibility check. Receipts lock with the claim | A receipt proves a specific expense, so finance sees the invoice next to its line. No client ever holds a write credential, so approved evidence can't be overwritten | Per-claim receipts (can't tell which line lacks evidence); presigned PUT (no size cap); files in Postgres |
| D-31 | Receipt retention | Storage objects are deleted only for claims that were never submitted (`current_revision = 0`). Objects referenced by any snapshot are kept forever. No sweeper in core | Evidence finance needs in a dispute can never be garbage-collected, with zero extra tables | Post-commit delete + sweeper (destroys snapshot evidence) |
| D-30 | **Object store** | `ReceiptStorage { put, get, delete, ping }`, implemented by `S3ReceiptStorage` (SeaweedFS 4.48 `weed mini` in compose), `MemoryReceiptStorage` (tests) and `FsReceiptStorage` (fallback, decided at the D7 noon gate). Signed URLs are an optional §8 item | §8 asks for a real object-store pattern, and the interface makes Azure Blob a swap rather than a rewrite | MinIO (archived, images gone); LocalStack (needs an auth token); local disk as primary |
| D-19 | **Approval thresholds** (§3.2 "document them") | Data rows in `approval_policy_tiers`, with exclusive lower bounds in paise. **L1 Line manager > ₹0; L2 Skip-level > ₹10,000.00; L3 Senior leader > ₹50,000.00; L4 CFO > ₹2,00,000.00, seeded inactive.** Chain = every active tier where total > `applies_above_minor`, ordered by `level` | Adding a tier is an INSERT, not a code change (§8 bullet 1). The routing answer becomes "a row lookup plus a resolver" | Hard-coded `if (amount > X)`; rules engine; versioned policy tables |
| D-20 | Approver resolution | Pure `buildChain()`. For each tier, try the primary (the `levels_up`-th manager, or the designated user), then escalate upward, then the fallback approver. A candidate is eligible if active, `can_approve`, not FINANCE, not the claimant and not already in the chain. If nobody is eligible → 422 `ROUTING_UNRESOLVABLE` and nothing changes. The chain is frozen at submit | One rule covers missing managers, self-approval, finance managers and duplicates, and N tiers always means N distinct signatures | Auto-approve when unresolvable; collapsing duplicate approvers; re-resolving lazily at decision time |
| D-16 | **Amount-change & recall rule** (§3.2 "decide and document") | Lines, title and receipts are **not editable while SUBMITTED** (409 `CLAIM_NOT_EDITABLE`, `details.hint = 'RECALL_TO_EDIT'`; DB UC002). The claimant can **recall** until the final approval. On recall, open steps become CANCELLED (kept), APPROVED steps stay in history on that revision, and the claim returns to DRAFT. The next submit builds a **brand-new chain from the new total**, and earlier approvals never carry over | Content is frozen while approvers look at it, so there is no time-of-check/time-of-use race, and there is one chain builder. Approvals bind to content, not to an amount bucket | Edit before first approval with auto re-route (two chain builders, approver race); keeping approvals if the tier count is unchanged |
| D-17 | Revision pin on decisions | Approve and reject bodies **require `revision`**. If it differs from `current_revision` → 409 `REVISION_MISMATCH` | After a recall and resubmit, a stale tab can't sign content its owner never saw | Unpinned decisions; step-id-addressed routes |
| D-15 / D-18 | **Rejection/resubmission model** | Statuses: DRAFT, SUBMITTED, APPROVED (terminal), REJECTED. A claim is editable iff DRAFT or REJECTED, and REJECTED stays REJECTED while being edited so the reason banner remains. One `/submit` endpoint handles first submit and resubmit. Every submission is a new revision: an INSERT-only `claim_submissions` row whose snapshot the DB verifies against the live lines, plus a fresh chain | History survives every edit (§3.3), and one submit path means one chain builder to test | IN_REVIEW status; REJECTED → DRAFT on first edit; a mutable submission outcome |
| D-22 | Audit trail | Services call `recordEvent(tx, ctx, event)` once per state change, in the same transaction. There are 6 typed event types. The app role has SELECT+INSERT only, and `forbid_mutation` raises UC007. A deferred `assert_transition_audited` refuses COMMIT without a matching event by the right actor (UC015) | Services can't forget to write it and can't edit it, and the event carries the real authenticated actor plus `request_id` | SECURITY DEFINER trigger-written events with GUCs; logs as the audit trail |
| D-23 | Transition timestamps | For `expense_app`, triggers stamp `now()` into `submitted_at`, `approved_at`, `rejected_at`, `activated_at`, `decided_at`, `cancelled_at` and `occurred_at`. Changing them outside their transition → UC010 | No code path can backdate an approval into an already-exported period | Injected app `Clock` in production paths |
| D-25 | **404-vs-403 policy** | Can't see or own the claim → **404 `CLAIM_NOT_FOUND`**, byte-identical to the response for a random UUID. Role gate → 403 `FORBIDDEN`. Approve/reject with no PENDING step for you → **403 `NOT_IN_YOUR_QUEUE`**, also for ids that don't exist. State conflicts → specific 409s. Ladder: 401 → 403 → 404 → 409 → 422 | "If you can't see it, it doesn't exist. If your role or queue forbids it, a specific 403. If the claim's state forbids it, a specific 409." That gives §6's clear, specific failure without an existence oracle | 403 for every invisible claim (oracle); 404 for out-of-queue approvals (less specific) |
| D-26 | Visibility | One `claimVisibilityWhere(actor)`: owner, OR has a step on the claim in PENDING/APPROVED/REJECTED, OR FINANCE. It is AND-composed into every claim, history and receipt read. Decided approvers keep read-only access. Finance sees all claims, including drafts, read-only; the finance list hides DRAFT by default | The out-of-scope row never leaves Postgres, and that *is* "refused at the point of the query" | Load-then-check in the service; UI hiding |
| D-46 | **RLS: core or optional** | **NOT PLANNED.** Documented as the next hardening step | The AND-composed predicate already meets §6. RLS would double the authz surface and force every read into an interactive transaction | RLS as core; RLS as a buffer item |
| D-34 / D-35 | **DB roles** | `postgres` (initdb only). `expense_owner` owns all objects and is used only by the migrate job and the host CLI. `expense_app` is the runtime role: DML per the privilege matrix, owns nothing, no TRUNCATE/TRIGGER/TEMP, SELECT-only on users, departments, categories and tiers. The app container never receives owner or superuser credentials (no `env_file`). The boot self-check `assertRuntimeRole()` exits if the role is privileged | The app's own connection can't disable triggers, truncate, change policy or rewrite history. That is what makes "provably impossible" true even against raw SQL from a compromised app | Connecting as superuser; `env_file: .env` on the app; DML on reference tables "for the seed" |
| D-28 | Validation | Shared strict Zod 4 schemas in `src/shared/schemas/*`. A total-like key → 422 `TOTAL_IS_DERIVED`. Another server-owned key → 422 `READ_ONLY_FIELD`. Unknown keys → 422 `VALIDATION_FAILED`. Amount 1..100,000,000 paise; date valid, ≥ 2000-01-01 and ≤ today in IST; category exists and is active; reject reason 10..1000 chars. DB CHECKs and triggers repeat the rules | Silently stripping a smuggled total would return 200, which is the "silent no-op" §6 forbids | Zod strip/passthrough; 90-day expense-age rule (CUT) |
| D-09 | Money | Integer paise everywhere: `amountMinor`/`totalMinor` on the wire, `number` in TS, `int4` in Postgres. INR only. Input is parsed with string math; display passes a decimal string to `Intl.NumberFormat('en-IN')` | `0.29 * 100 === 28.999999999999996`. Integers can't drift | Floats, decimal.js, BigInt, `numeric` |
| D-10 | Dates & time zone | Code constant `BUSINESS_TIMEZONE = 'Asia/Kolkata'`. Instants are `timestamptz(3)` in UTC. Expense dates are `YYYY-MM-DD` strings end to end. Periods are inclusive IST dates, converted to a half-open UTC range by `businessDayRangeToUtc()` | Finance reasons in IST calendar days, and millisecond precision round-trips the keyset cursors | Env-configured time zone; date-picker and date libraries |
| D-11 | IDs | `uuid DEFAULT uuidv7()` generated by PG 18. `claim_number` = `EXP-2026-000123` from a sequence. Drift fallback: the service runs `SELECT public.next_claim_number()` inside the same `withTx` as the INSERT and passes the result; never `nextval` plus JS formatting | Time-ordered keys keep B-trees compact; finance needs unique numbers, not gapless ones | Serial ints (enumerable); UUIDv4 |
| D-29 | Lists | Three persona endpoints (`/claims`, `/approvals`, `/finance/claims`), each with a route-fixed scope. Keyset pagination on `(sortValue, id)` with `LIMIT n+1` and an opaque cursor. Strict query schemas. No `COUNT(*)` | §6: filtering never loads every claim. Each page costs O(page size) and stays stable under concurrent inserts | OFFSET; one polymorphic `?scope=` endpoint |
| D-32 / D-33 | **Export streaming & period semantics** | `GET /api/v1/finance/exports/approved-claims?from&to[&status=APPROVED]`, FINANCE only. The period is on the final `approved_at` in IST, `[from 00:00, (to+1) 00:00)`, and also `< asOf`. `status` accepts only `APPROVED` (anything else → 422 `EXPORT_STATUS_NOT_ALLOWED`). One row per line, taken from the **approved snapshot**. A pull-based `ReadableStream` fetches 500-claim keyset batches; on error the download fails. Range ≤ 366 days. RFC 4180 CSV with BOM and formula escaping | Approved claims are terminal, with a DB-stamped `approved_at` and frozen snapshot rows, so a closed period's export is stable. Memory is bounded by batch size, never by period length | Building the CSV in memory; filtering by expense date (late approvals would rewrite closed months); live joins to reference data; an async job |
| D-42 / D-43 / D-44 | **Test tooling** | Vitest 5 with projects `unit`, `integration` and `component`. **One Testcontainers PG 18.6** container built with the same roles script; the code under test connects as `expense_app`; test files run serially; tables are TRUNCATEd between tests; `afterEach(assertTotalsInSync)`. Routes are called in-process with a real `NextRequest`. Playwright 1.63 runs against the compose production image | Only a real Postgres proves triggers, locks and grants, and running as the app role proves what the production credentials cannot do | Mocking Prisma; SQLite/pg-mem; compose `db-test` profile; Cypress |
| D-40 | Logging | pino JSON to stdout. AsyncLocalStorage carries `{requestId, userId, route}`. `x-request-id` is echoed on every response, included in error envelopes and stored in `claim_events.request_id`. OpenTelemetry is OPTIONAL | Every line in a request is correlated, and `request_id` joins the audit row to the logs in a dispute | `console.log`; logs as audit |
| D-38 / D-41 | Compose & ops | Services: `postgres`, `objectstore`, `migrate` (one-shot: migrate → ensure-bucket → seed) and `app`. Boot order via `depends_on` conditions. Per-service `environment:` lists. Ports bound to 127.0.0.1. Probes `/api/health/live` and `/api/health/ready` (the latter returns 503 if an integrity trigger is disabled) | Migrating is a release step, which maps to an Azure Container Apps Job. The runtime image holds no DDL rights | Migrations in the app entrypoint; Alpine images |
| D-45 | Seed | One `@acme.test` cast for seed, tests, Playwright and README. Seeded as owner, **through the real services**, with triggers on. Split in two: `seedReference()` (departments, categories, tiers; `INSERT … ON CONFLICT (code) DO NOTHING`) runs on **every** release; the cast and demo claims C01–C12 run only when `SEED_ON_START=true` and `users` is empty. Seeded history is dated through `ServiceCtx.clock` (`SeedClock`, 02 §9) | Seeded data obeys the same integrity rules as production, and every environment gets its policy rows | Raw inserts with triggers disabled; seeding tiers only with the demo cast |
| D-02 | Versions | Exact pins: Node 24.21.0, pnpm 10.34.6, Next 16.4.0 (moving to the 16.4.x out-of-band security patch on 14 Oct), React 19.3.0, Prisma 7.10.0, TypeScript 6.0.3, Zod 4.6.5, Vitest 5.0.3, Playwright 1.63.0, `postgres:18.6-trixie` and `node:24.21.0-trixie-slim` (both digest-pinned since P0; compose and Testcontainers use the same Postgres digest) | Checked against the registries on 2026-10-12. Prisma 8 is an RC and lacks isolation levels and P2002 codes; TS 7 has no API for type-aware lint | Prisma 8 RC; TypeScript 7; floating ranges |
| D-51 | Scope guard | Cut: 90-day expense-age rule, HEIC, per-line endpoints, policy versioning, Entra code, admin UI. Claim `version` is OPTIONAL | §8 says "don't add new features, deepen what's here" | — |

---

## 2. Problem understanding

### 2.1 Actors and capabilities

| Actor | Representation | Can | Cannot | Demo persona |
|---|---|---|---|---|
| Claimant (every user) | Any active `users` row | Create, edit, submit, recall and delete own claims; view own claims; edit and resubmit rejected claims | See anyone else's claims | `asha.rao@acme.test`, `arjun.das@acme.test` |
| Approver | `can_approve = true` (role EMPLOYEE or ADMIN) | See `/approvals` (own PENDING steps; decided ones read-only); approve or reject their own PENDING step (reason required to reject) | Act on WAITING steps or other approvers' steps; approve their own claim | `ravi.menon` (L1), `meera.iyer` (L2), `vikram.shah` (L3), `neha.kapoor` (outside Asha's chain) |
| Fallback approver | `is_fallback_approver = true` (exactly one) | Same as an approver; picked when a tier can't resolve otherwise | — | `deepa.menon` (also the designated CFO for L4) |
| Finance | `role = 'FINANCE'` (`can_approve` is false, enforced by CHECK) | Read every claim, read-only; finance list; CSV export | Approve, reject or edit anyone else's claim | `farah.khan@acme.test` |
| Admin | `role = 'ADMIN'` | Nothing extra in the app; configuration happens through migrations and owner scripts | Read others' claims | `admin@acme.test` |

**Lifecycle in one line:** DRAFT → SUBMITTED (chain built, level 1 PENDING) → APPROVED (terminal) or REJECTED (editable, then resubmitted as a new revision). Recall returns a SUBMITTED claim to DRAFT. The full state machine, transition table and event catalogue are in [02-domain-and-workflow.md](docs/design/02-domain-and-workflow.md).

### 2.2 Core invariants

Each invariant names the layers that enforce it, from the outermost (request validation) down to the database, and the tests that prove it.

| ID | Invariant | Enforced by | Proven by |
|---|---|---|---|
| INV-1 | `claims.total_minor = Σ line_items.amount_minor` at every COMMIT, under every code path and under concurrency | Zod `TOTAL_IS_DERIVED` → no service writes the column → recompute triggers + `claims_guard` UC003 → deferred `assert_claim_total_consistent` UC009 → `expense_app` grants | TC-I12, TC-I13, TC-I00, global `afterEach(assertTotalsInSync)`, `pnpm verify:integrity` |
| INV-2 | An APPROVED claim is terminal: its title, lines, amounts and receipts never change | Service 409 `CLAIM_LOCKED` → `claims_guard`, `assert_claim_editable` and `receipts_before_write` UC001 | TC-I11, TC-I27, TC-E05 |
| INV-3 | Title, lines and receipts are editable iff the claim is DRAFT or REJECTED | Service 409 `CLAIM_NOT_EDITABLE` → DB UC002 | TC-I11, TC-I21 |
| INV-4 | A claim is readable only by its owner, an approver with a PENDING/APPROVED/REJECTED step on it, or FINANCE, and this is decided **inside the SELECT** | `claimVisibilityWhere(actor)`; lint keeps Prisma inside repositories | TC-I17, TC-I18, TC-E02 |
| INV-5 | Only the approver holding the PENDING step on the current revision can decide, and only once | Role gate → `lockClaimRoutedToMe` → `revision` pin → conditional UPDATE (`count = 1`) → `approval_steps_guard` UC006/UC008 → partial unique index (one PENDING per submission) | TC-I19, TC-I20 |
| INV-6 | A submitted chain has exactly one step per applicable active tier, levels 1..n, with distinct eligible approvers who are never the claimant or FINANCE | `buildChain()` → `claims_guard` UC012 → `approval_steps_guard` UC008 (at insert and at decision) → `UNIQUE(submission_id, approver_id)` | TC-U03, TC-I15, TC-I16, TC-I19 |
| INV-7 | Every status transition and decision has exactly one typed audit event, written in the same transaction by the authenticated actor. Events are never updated or deleted | `recordEvent()` → deferred `assert_transition_audited` UC015 → SELECT+INSERT grant + `forbid_mutation` UC007 | TC-I23 |
| INV-8 | Each submission snapshot equals the live lines and total at submit, and never changes afterwards | `claim_submissions_verify` UC016 → INSERT-only | TC-I15, TC-I22 |
| INV-9 | `approved_at` is set iff the claim is APPROVED (same for `rejected_at`), and the DB stamps transition timestamps | CHECKs + trigger stamping + UC010 | TC-I28 › "backdating approved_at as expense_app raises UC010" |
| INV-10 | The export contains only APPROVED claims approved within the IST period and before `asOf`, rendered from the approved snapshot | Export predicate + CHECK + snapshot rows | TC-I28 |
| INV-11 | The runtime credentials can't change the schema, disable triggers, truncate, or write identity, reference or policy tables | `expense_app` grants; no owner variables in the app env; `assertRuntimeRole()`; ready probe | TC-I07, TC-I06, TC-E06 |
| INV-12 | Every `/api/v1` route except login authenticates inside its own handler | `defineRoute` + `PUBLIC_ROUTES` | TC-I01 |
| INV-13 | Money is integer paise end to end, and no float ever touches an amount | Zod integer, `int4`, string-math parsing | TC-U01, TC-C01 |
| INV-14 | Receipt objects referenced by any submitted revision are never deleted | Retention rule D-31 | TC-I22, TC-I27 |

### 2.3 What reviewers will check (§6) and how we prove it

| §6 check | Mechanism | Test name(s) (verbatim) | Phase |
|---|---|---|---|
| Positive amount, valid date, real category; a zero-line claim isn't submittable | Strict shared Zod → service category checks → DB CHECKs + `line_items_before_write` (UC013/UC014) + `claims_guard` and `claim_submissions_verify` (UC004) | TC-I10 › "rejects %s with 422 VALIDATION_FAILED at the field path"; TC-I15 › "submitting a claim with zero line items returns 422 NO_LINE_ITEMS", "raw UPDATE claims SET status='SUBMITTED' on an empty claim raises UC004" | P2, P3 |
| Editing an approved claim, or approving a claim not in your queue, gives a clear, specific failure | Error ladder (D-25): UC001 → 409 `CLAIM_LOCKED`; a PENDING-scoped lock miss → 403 `NOT_IN_YOUR_QUEUE`; SQLSTATEs are mapped by code | TC-I11 › "every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED"; TC-I19 › "approving a claim that is not in my queue returns 403 NOT_IN_YOUR_QUEUE", "approving a non-existent id returns the same 403 NOT_IN_YOUR_QUEUE body"; TC-U08 › "maps every UC SQLSTATE to its catalogue code and status" | P4, P5 |
| Every route requires a real, authenticated user | `defineRoute` authenticates inside every handler; `PUBLIC_ROUTES` = login + 2 probes; the `(app)` layout redirects | TC-I01 › "only PUBLIC_ROUTES are public", "every non-public route returns 401 UNAUTHENTICATED with no cookie", "the x-middleware-subrequest header does not bypass authentication"; TC-I02 › "logout deletes the session and the old cookie gets 401"; TC-E04 › "every (app) page redirects to /login without a session" (pages) | P1; P8 (TC-E04, CORE) |
| **Sharpest:** an approver requesting a foreign claim by id is refused at the point of the query | `claimVisibilityWhere(actor)` AND-composed into the one SELECT; decisions go through the PENDING-scoped lock; Prisma is importable only in repositories | **TC-I17 › "approver requesting a claim outside their queue by id is refused at the point of the query"** + "GET /claims/:id returns 404 CLAIM_NOT_FOUND identical to the 404 for a random UUID"; TC-I18; TC-E02 | **P2 (owner-scoped first form, D4)**, P4 (routed-approver form D5; complete D6), P5/P6 (history/recall and receipt rows) |
| The total is provably impossible to desynchronise | Recompute triggers + guard + deferred COMMIT check + `expense_app` privileges | **TC-I12 › "no code path can leave claims.total_minor different from the sum of its line items"**; TC-I13 › "a second writer waits on the claim lock (visible in pg_stat_activity) and the final total is 300"; TC-I00 | **P0, P2 (D3 PM to D4)** |
| The approver queue and finance export filter by date range and status without loading every claim | Keyset pagination + SQL filters + partial/composite indexes; streamed keyset export; EXPLAIN evidence | TC-I25 › "from/to use IST day boundaries (23:59:59.999 IST in, 00:00 next day out)", "keyset pages are complete and disjoint including ties on activated_at"; TC-I28 › "keyset batches (batchSize=3) with tied approved_at emit every line exactly once", "status=APPROVED is accepted and returns the same CSV as omitting status", "status=REJECTED returns 422 EXPORT_STATUS_NOT_ALLOWED"; `docs/perf/explain-*.txt` | P4, P7 |
| Submission, approval and rejection each leave a structured trace | `recordEvent()` in the same transaction; append-only; deferred `assert_transition_audited`; `request_id` links to logs | TC-I23 › "submit, approve (intermediate and final), reject and recall each write exactly one typed event", "event request_id equals the response x-request-id", "a status change without an event fails at COMMIT with UC015" | P3 to P5 |
| `docker compose up` with nothing but a documented `.env` | One-shot `migrate` job, healthchecks + `depends_on` conditions, complete `.env.example`, no owner credentials in the app | TC-E06 › "a clean docker compose up is healthy and the app container holds no owner or superuser credentials" + P0 and P8 clean-boot rehearsals | P0, P8 |

---

## 3. Architecture in one picture

```mermaid
flowchart LR
  subgraph browser["Browser"]
    UI["React client components<br/>TanStack Query, RHF, shared Zod"]
  end
  subgraph app["app container: Next.js 16.4 standalone, uid 1000"]
    PX["proxy.ts<br/>optimistic page redirect only"]
    SHELL["(app)/layout.tsx<br/>getActor() shell, no data reads"]
    RH["Route handlers /api/v1<br/>defineRoute pipeline"]
    SVC["Services<br/>Actor, withTx, claim lock first"]
    REPO["Repositories<br/>claimVisibilityWhere(actor)"]
    STORE["ReceiptStorage<br/>S3, FS or Memory"]
  end
  PG[("PostgreSQL 18.6<br/>triggers, CHECKs, grants")]
  OS[("SeaweedFS 4.48<br/>S3 API")]
  MIG["migrate job, tools target<br/>migrate, ensure-bucket, seed"]
  LOGS["stdout JSON logs<br/>pino with requestId"]
  UI -->|fetch with session cookie| RH
  UI -.->|page navigation| PX
  PX -.-> SHELL
  RH --> SVC
  SVC --> REPO
  REPO -->|SQL as expense_app| PG
  SVC -->|outside any transaction| STORE
  STORE --> OS
  RH --> LOGS
  MIG -->|DDL and seed as expense_owner| PG
  MIG --> OS
```

- **One image, two targets.** `runner` runs the Next standalone `server.js` as non-root, with no CLI, dev dependencies or `.env`. `tools` runs the one-shot `migrate | seed | ensure-bucket | release` jobs as `expense_owner`. The app never holds DDL rights.
- **One door.** Every UI read and write goes `HTTP /api/v1 → defineRoute → service → repository → Postgres`. Server Components render only the shell, `proxy.ts` is a UX convenience, and deleting it changes nothing about API security.
- **Pipeline.** request id → authenticate (401) → CSRF (403) → role gate (403) → path params (404) → content type (415) → Zod (422) → service → error mapping → access log ([04](docs/design/04-security-and-api.md)).
- **Services** are `(ctx: ServiceCtx, ...ids, input?)` with `ServiceCtx = { actor; requestId; clock?: SeedClock }` (C-26). They run every mutation in `withTx`, lock the claim first with an actor-scoped `FOR NO KEY UPDATE`, re-read, then write with conditional updates. Storage and network calls never happen inside a transaction ([02](docs/design/02-domain-and-workflow.md)).
- **Repositories** are the only Prisma importers. Every claim, history and receipt read composes `claimVisibilityWhere(actor)`, and there is no unscoped `findClaimById`.
- **Postgres is the last line of defence.** It holds 10 PL/pgSQL functions plus 1 SQL function, CHECKs, partial indexes and explicit grants. Business-rule violations raise SQLSTATEs UC001 to UC017; `readSqlState()` → `map-error.ts` turns them into the same API codes the service would have returned ([03](docs/design/03-data-model-and-integrity.md)).
- **Evidence vs operations.** Audit rows are written inside the transaction (evidence). Log lines are written after commit and carry the same `requestId` (operations) ([06](docs/design/06-cross-cutting.md)).
- **Folder layout, versions, Dockerfile and compose** are in [01-architecture-and-stack.md](docs/design/01-architecture-and-stack.md).

---

## 4. Phase-wise plan

### 4.0 Summary

| Phase | Goal | Days (2026) | Key exit criteria |
|---|---|---|---|
| **P0** Walking skeleton + integrity spike | Prove Prisma 7 + hand-written triggers + DB roles + standalone Docker + test DB on the real stack | D1 Tue 13 Oct to D2 AM Wed 14 Oct (1.5 d) | **Done, verified D2 AM.** `docker compose up --build --wait` healthy; TC-I00 (a) to (e) green; no migrate drift twice |
| **P1** Identity + request spine | Auth, CSRF, validation, errors and logging for every route; route-inventory test first | D2 PM Wed 14 to D3 AM Thu 15 Oct (1.0 d) | TC-I01 to TC-I05 green; lint fixture fails; login → shell. End of D2: Plan B gate (already passed: TC-I00 green in P0) |
| **P2** Draft claims + total integrity | Draft CRUD end to end; full desync proof; first form of the sharpest test | D3 PM Thu 15 to D4 AM Fri 16 (1.0 d) | **TC-I12, TC-I13, TC-I17 (owner-scoped first form)** + TC-I09, TC-I10 green by end of D4 |
| **P3** Submit, routing, audit | Data-driven chain at submit; snapshot; one typed event per transition | D4 PM to D5 AM Mon 19 (1.0 d) | TC-U03, TC-I15 green; L4 activation gives a 4-step chain with no code change |
| **P4** Approver queue + decisions | Authorization slice: queue, approve/reject ladder, routed-approver form of the sharpest test | D5 PM to D6 Tue 20 (1.5 d) | **TC-I17 approve/reject** (end of D5) + TC-I18 (fixture F1), TC-I19, TC-I20 (parallel approvals), TC-I25 green (gate end of D6) |
| **P5** Reject, recall, resubmit, history, lock proof | §3.3, §3.4 and §7 Q2/Q3 runnable | D7 AM Wed 21 (0.5 d) | TC-I11, TC-I21, TC-I22, TC-I18 recall/history, TC-I20 race green; demo scripts work |
| **P6** Receipts | Per-line receipts through `ReceiptStorage`, locked with the claim | D7 PM Wed 21 + D10 AM Mon 26 (1.0 d) | TC-I27 green; storage decision made at D7 noon |
| **P7** Finance list + streamed export + EXPLAIN | Read-only cross-employee view; memory-bounded CSV; plan evidence | D8 Thu 22 Oct (1.0 d) | TC-I26, TC-I28 green; `docs/perf/*.txt` (10k-claim perf seed) show Index Scan with no Sort; perf work not done by 16:00 finishes on D10 after P6 |
| **P8** Evidence + hardening | Reviewer can clone, run, read and verify | D9 Fri 23 Oct (1.0 d) | `pnpm verify` + core e2e green; clean-clone rehearsal; README + 8 ADRs |
| **BUF** Buffer | Absorb slips; rehearse; then optional §8 depth | D10 PM Mon 26 Oct (0.5 d) | Slips closed; demo rehearsed twice |

**Budget:** 1.5 + 1 + 1 + 1 + 1.5 + 0.5 + 1 + 1 + 1 = **9.5 planned days + 0.5 buffer day = 10 working days**, at about 7 productive hours a day. The weekends (17–18 and 24–25 Oct) are not part of the plan.

How the budget moved from the first draft:
- P0 grew by half a day (D2 AM). The object-store probe moved to the D7 noon gate, TC-I07 and TC-I08 could start in P2 (in practice both were built in P0), Day-1 checks 2–4 moved to wherever each is first needed (in practice all but the `db:reset` check closed in P0), and the CI workflow moved to P8. The Plan B gate moved to the end of D2.
- P1 moved to D2 PM + D3 AM. The login page, shell, proxy and api-client are its D3 AM half.
- P2 shrank to one day. The `/claims` list UI is built once on D6 AM as the shared `PagedTable` with `/approvals`, and TC-C01 moved to D6 PM.
- P6 is planned explicitly as D7 PM + D10 AM instead of floating.
- Cut items 3, 4 and 5 are applied up front (they cost nothing against §6).
- The half day for all this comes out of BUF (1.0 → 0.5 d).

### 4.1 Rules every phase follows

- **It ships a vertical slice:** migration → repository → service → route → UI → tests → log lines, together. The learning path's "deliver a vertical slice" is the unit of work.
- **New routes** are written with `defineRoute`, so TC-I01 covers them automatically; append their keys to `EXPECTED_ROUTES` in `tests/helpers/route-manifest.ts` in the same commit (P1: 12 keys; final: 29). **New tables** get explicit grants in the same migration, a row in the TC-I07 privilege matrix and their trigger list in TC-I08.
- **Signatures** follow C-26: `findClaimForActor(actor, claimId, select)` in `claim-visibility.ts` (no tx); `lockOwnedClaim(tx, actor, claimId)` and `lockClaimRoutedToMe(tx, actor, claimId)` in `claims.repo.ts`, both returning `LockedClaim | null` (the service throws); every service function is `(ctx: ServiceCtx, ...ids, input?)`, named `createClaim`, `getClaim`, `replaceClaim`, `deleteDraft`, `submit`, `recall`, `approve`, `reject`, `upload`.
- **Seed changes:** a phase that extends the seed also proves `docker compose down -v && docker compose up --build --wait` is healthy before it closes.
- **Before a phase closes,** `pnpm verify` (generate, typecheck, lint, format check, unit, component, integration) is green and the work is committed in small, named commits.
- **Contract changes:** names, codes, routes and thresholds match the design docs exactly. If one must change, write the ADR note first, then change the code.
- **Daily:** start with `pnpm verify`; end with a commit and a note of any slip against [§5](#5-day-by-day-timeline-and-critical-path). At a gate, if you are more than half a day behind, apply the cut list.

---

### P0: Walking skeleton + integrity spike (D1 + D2 AM, Tue 13 to Wed 14 Oct). Done

**Status: done and verified on Wed 14 Oct (D2 AM).**
- `docker compose up --build --wait` is healthy: postgres healthy, `migrate` Exited 0, app healthy and running as uid 1000. The image builds with no `.env`, and `pnpm build` works with no `.env`.
- Typecheck, lint, format and unit are green (TC-U10 4/4, built here ahead of P1). Integration is 15/15 green on Testcontainers `postgres:18.6`: TC-I00 (a) to (e), TC-I06, TC-I07 and TC-I08.
- `pnpm db:deploy && pnpm db:diff-check` reports "No difference detected", and `prisma migrate dev --create-only` run twice produces empty migrations.
- The app refuses to boot with owner credentials (exit 1).
- Prisma 7.10 + `PrismaPg` emits `query` events (Day-1 check 1).
- As `expense_app`, reads work and `CREATE TABLE` and `TEMP` are denied. **Still open:** proving the privileges survive `pnpm db:reset`, which waits for the user's consent (Day-1 check 4 below).

**Deviations found while building P0** (the design docs follow these):
- Tailwind 4 is wired by the create-next-app 16.4 template's `@tailwindcss/turbopack` loader in `next.config.ts`. There is no `postcss.config.mjs` and no `@tailwindcss/postcss` dependency. The Vitest config file is `vitest.config.mts`.
- The ESLint pages zone can't use the gitignore-style group `['@/server/**', '!@/server/auth/rsc']`, because a file can't be re-included once its parent directory is excluded. `eslint.config.mjs` uses the regex `'^@/server(?:$|/(?!auth/rsc$))'` instead ([01 §7.2](docs/design/01-architecture-and-stack.md)). TC-U10 lints its text fixtures with typescript-eslint's `disableTypeChecked` override (text fixtures can't be type-checked); the rules under test come from the real config.
- The postgres healthcheck probes over TCP (`pg_isready -h 127.0.0.1 …`). During initdb Postgres listens only on the socket, so a socket probe can report healthy before `01-roles.sh` has finished.
- The Dockerfile build stage runs `mkdir -p public` (git doesn't track empty directories). Base images are digest-pinned: `node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66` and `postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`. Compose and Testcontainers use the same Postgres digest.
- Under `tsx` in this `"type": "module"` repo, `@next/env` must be a default import: `import nextEnv from '@next/env'; nextEnv.loadEnvConfig(…)`. A named import fails. `prisma.config.ts` is unaffected.
- `tests/helpers/global-setup.ts` has an external-DB mode: when `TEST_PG_SUPERUSER_URL` is set, it uses that empty PG 18 instead of Testcontainers. Testcontainers stays the default.
- Prisma 7.10's `migrate reset` (and therefore `pnpm db:reset`) refuses to run when it detects an AI agent, unless the user explicitly consents through `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`. An agent never sets that variable itself: it asks the user, who runs the reset or gives consent.

**Goal.** Before any feature code exists, prove the riskiest platform assumptions on the real stack:
- Prisma 7.10 with hand-written triggers in migrations.
- The two DB roles.
- Next standalone in Docker.
- A real-Postgres test harness.

The object-store signal moved to the D7 noon gate (P6), because it decides nothing earlier.

**Why now.** D-12 (the DB-owned total) and the "provably impossible" claim both depend on statement triggers, a deferred check and grants working through Prisma 7's driver adapter. If they don't, the Plan B decision (D-13) must be made before anything is built on top.

**Head start: the integrity SQL is already verified.** During planning, the full trigger, constraint and grant SQL in [03 §16](docs/design/03-data-model-and-integrity.md#16-verified-sql-migration-by-migration) ran against a real PostgreSQL 18.4 (embedded-postgres, no Docker) as `expense_app`. It passed **127/127** checks: total = sum, the guard, line moves, interleaved concurrent transactions, APPROVED/SUBMITTED locks, zero-line submit, append-only events, the role unable to disable guards, state-machine gating, and the Prisma 7.10 + adapter-pg error shapes. The proof found and fixed three bugs (BUG-1 double-drawn claim numbers, BUG-2 snapshot editable before the status flip, BUG-3 wrong SQLSTATE precedence). `schema.prisma` validates with Prisma 7.10.0, and `migrate diff` is empty. **Copy the SQL from 03 §16 verbatim into the migrations; don't retype it.** P0 is then about proving it through *your* stack (Prisma migrate, Docker, Testcontainers), not about designing it.

**Tasks**

*Docs-DevOps (toolchain)*
- [x] Start Docker Desktop yourself (the daemon is stopped today) and give it at least 6 GB RAM. `docker info` must work.
- [x] Toolchain:
  - `nvm install 24.21.0` and commit `.nvmrc` (local 24.13.1 is too old).
  - `corepack enable` and `"packageManager": "pnpm@10.34.6"`.
  - `git init`, with `.gitignore` covering `.env`, `.next`, `src/generated/prisma`, `e2e/.auth` and `.data`.
- [x] `pnpm create next-app@16.4.0` (App Router, TS, Tailwind, ESLint, `src/`), then re-pin to C-12: TS 6.0.3, React 19.3.0, ESLint 9.39.5. Add `"type": "module"`. Tailwind 4 stays on the template's `@tailwindcss/turbopack` loader (no PostCSS config).
- [x] `next.config.ts`: `output: 'standalone'`, `cacheComponents: false`, `poweredByHeader: false`.
- [x] `pnpm-workspace.yaml` with `onlyBuiltDependencies: [@prisma/engines, prisma, esbuild, unrs-resolver]`. Confirm the list against the install warnings.

*DB*
- [x] `docker/postgres/initdb/01-roles.sh`: copy it verbatim from [01 §10.4](docs/design/01-architecture-and-stack.md) (`ALTER DATABASE :"db" OWNER TO expense_owner`, psql variables). [03 §16.1](docs/design/03-data-model-and-integrity.md#161-bootstrap-01-rolessh-statements-not-a-migration) is the statement list it implements; its `CREATE DATABASE` line applies only to `expense_perf`, because the postgres image has already created `POSTGRES_DB` when initdb scripts run. The script:
  - Creates `expense_owner` and `expense_app` with the D-34 attributes.
  - Sets `expense_app` role settings: `statement_timeout 15s`, `lock_timeout 5s`, `idle_in_transaction_session_timeout 30s`.
  - Makes `expense_owner` the owner of `expense_claims` and schema `public`.
  - Runs `ALTER DATABASE expense_claims SET timezone TO 'UTC'`.
  - Runs `REVOKE ALL ON DATABASE expense_claims FROM PUBLIC` (drops TEMPORARY), `GRANT CONNECT … TO expense_app`, `REVOKE ALL ON SCHEMA public FROM PUBLIC` and `GRANT USAGE ON SCHEMA public TO expense_app`.
- [x] `prisma/schema.prisma`:
  - Generator `prisma-client` → `../src/generated/prisma`, with `moduleFormat = "esm"` and `previewFeatures = ["partialIndexes"]`.
  - Models `Department`, `User`, `Session`, `Category`, `Claim`, `LineItem`.
  - `prisma.config.ts` reads `MIGRATE_DATABASE_URL ?? DATABASE_URL`.
- [x] Migration `…_init` (`prisma migrate dev --create-only`): enums `user_role` and `claim_status`, the six tables and their indexes. Prepend `claim_number_seq` and `next_claim_number()`.
- [x] Migration `…_integrity_core`:
  - Functions #1–#5: `assert_claim_editable`, `line_items_before_write`, `line_items_recompute_claim_totals`, `claims_guard` v1, `assert_claim_total_consistent`.
  - Every function is schema-qualified with `SET search_path = pg_catalog, public, pg_temp`.
  - The CHECKs from C-03, and the view `v_claim_total_drift`.
- [x] Migration `…_privileges`: explicit grants per the matrix for these tables, the sequence and the view. No `ALTER DEFAULT PRIVILEGES`. Then append `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO expense_app;` ([03 §16.4](docs/design/03-data-model-and-integrity.md#16-verified-sql-migration-by-migration)).
- [x] Run `prisma migrate dev --create-only` twice: both runs produce an empty migration. From here on one drift rule applies everywhere: **Drift = `pnpm db:deploy && pnpm db:diff-check`** (`--from-config-datasource --to-schema prisma/schema.prisma --exit-code`), with no shadow DB.

*Backend*
- [x] `src/server/db/client.ts` (`getDb()` with `PrismaPg`).
- [x] `src/server/db/tx.ts` (`withTx`, `maxWait 5000`, `timeout 10000`).
- [x] `src/server/db/pg-error.ts` `readSqlState()`, written against the error shapes the spike records (Prisma P2039/P2010 meta, a raw `DriverAdapterError` at COMMIT, pg `DatabaseError.code`).
- [x] `src/server/db/introspection.ts` (`readRoleAttributes()`, `countDisabledTriggers()`, `ping()`, `readinessProbe()`), used by `runtime-role.ts` and the ready route.
- [x] `src/server/auth/runtime-role.ts` `assertRuntimeRole()`. `src/instrumentation.ts` calls it and runs `process.exit(1)` on failure.
- [x] `src/app/api/health/live/route.ts` and `src/app/api/health/ready/route.ts`: `SELECT 1` with a 1 s timeout, and zero disabled non-internal triggers in `public`. (P1 rewraps both in `defineRoute`.)

*Tests*
- [x] `vitest.config.mts`:
  - Projects `unit`, `integration`, `component`.
  - `server-only` aliased to `tests/helpers/empty-module.ts`.
  - Integration runs with `fileParallelism: false`.
- [x] `tests/helpers/global-setup.ts`: start one `postgres:18.6-trixie` (the compose digest) via `@testcontainers/postgresql` 12.2.0 with `01-roles.sh` mounted, then run `prisma migrate deploy` as `expense_owner`. External-DB mode: with `TEST_PG_SUPERUSER_URL` set, it uses that empty PG 18 instead.
- [x] `tests/helpers/db.ts`: `ownerSql`, `appSql`, `resetDb`, `assertTotalsInSync`. Add `tests/helpers/integration-setup.ts` (the per-file `setupFiles` hook: reset + the global `afterEach(assertTotalsInSync)`; see [07 §3](docs/design/07-testing.md)).
  - `resetDb()` truncates only the transactional tables that exist: it intersects `{claims, line_items, receipts, claim_submissions, approval_steps, claim_events, sessions, export_runs}` with the tables present in `public`, then runs one TRUNCATE over that list.
  - The storage reset (`getStorage`, imported lazily) joins in P6. `restoreReference` is added in P1 (cast flags only) and extended to tiers in P3.
- [x] **Day-1 library checks** (each one was listed as unverified in the design docs; write the answer into ADR-0001):
  - [x] Prisma 7.10 with `PrismaPg` emits `query` events when `log: [{ emit: 'event', level: 'query' }]` is set (TC-I17 captures the SQL this way). Verified.
  - [x] Testcontainers 12.2: the `withCopyFilesToContainer` `mode` option (the roles script must be executable) and `withTmpFs`. Resolved by the harness itself, which uses both and runs green.
  - [x] Drift checking: the drift rule above needs no shadow DB, so the `--from-migrations` shadow-DB question (P1003) no longer applies.
  - [ ] The two lines appended to the `privileges` migration survive a reset. Verify: run `pnpm db:reset` against compose postgres; as `expense_app`, `SELECT count(*) FROM claims` succeeds and `CREATE TABLE x(i int)` fails with 42501. TC-I07 runs on a fresh DB via `migrate deploy`, so it doesn't cover the reset. **Pending the user's consent** (Prisma 7.10 refuses `migrate reset` under an AI agent without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`).
- [x] **TC-I00** `tests/integration/spike/integrity-spike.int.test.ts`:
  - "(a) app role raw UPDATE claims SET total_minor raises UC003"
  - "(b) Prisma lineItem.update on a SUBMITTED claim raises UC002 and its error shape is recorded"
  - "(c) owner-disabled recompute trigger makes COMMIT fail with UC009"
  - "(d) app role cannot DISABLE TRIGGER, TRUNCATE or SET session_replication_role (42501)"
  - "(e) two connections inserting lines into one claim serialize and the total is 300"
- [x] TC-I07 `db/privileges.int.test.ts` and TC-I08 `db/schema-objects.int.test.ts` for the P0 tables. (The re-slot allowed them to start in P2; both were built here.)
- [x] TC-I06 › "/api/health/live returns 200 without the DB" and "/api/health/ready returns 503 NOT_READY when an integrity trigger is disabled".

*Docs-DevOps (packaging)*
- [x] `Dockerfile` with targets `base → deps → build → runner | tools` on the digest-pinned `node:24.21.0-trixie-slim`. The build stage runs `mkdir -p public`. The runner uses standalone `server.js`, uid 1000, `HOSTNAME=0.0.0.0`, and a Node-fetch `HEALTHCHECK` on `/api/health/ready`.
- [x] `docker/tools/entrypoint.sh` with `migrate | seed | ensure-bucket | release`. Seed and ensure-bucket are stubs for now.
- [x] `compose.yaml`:
  - Services `postgres` (digest-pinned), `migrate` and `app`, with `depends_on` conditions.
  - The postgres healthcheck uses TCP (`pg_isready -h 127.0.0.1 …`), so it can't report healthy while initdb is still running `01-roles.sh` on the socket.
  - Explicit per-service `environment:` and **no `env_file`**.
  - Ports bound to `127.0.0.1`.
- [x] `.env.example` with the C-11 values, and `.dockerignore` excluding `.env*`, `node_modules`, `.next` and tests.
- The object-store probe moved to the D7 noon gate (see P6).

**Deliverables.**
- A running 3-service stack.
- Migrations `init`, `integrity_core` and `privileges`.
- The spike suite.
- Recorded Prisma error shapes and the fallbacks that were used.

**Exit criteria (all met on D2 AM).**
- [x] `docker compose down -v && cp .env.example .env && docker compose up --build --wait` brings every service up healthy.
  - The app runs as uid 1000.
  - The image builds with no `.env` present.
  - App logs show no `Cannot find module '@prisma/client-…'`.
- [x] `prisma migrate dev --create-only` produces an empty migration twice in a row, and `pnpm db:deploy && pnpm db:diff-check` reports no difference.
- [x] TC-I00 (a) to (e) are green, and the two TC-I06 tests are green.

**Walkthrough evidence.**
- The spike file, which grows into the integrity suite.
- `docker compose ps` output.
- The Prisma error shapes, recorded for ADR-0003, and the fallbacks used, recorded for ADR-0001.

**Risks & fallback.**
- Standalone image with Prisma 7 ESM and the pnpm linker: try `nodeLinker: hoisted`, then `next build --webpack`, then non-standalone `next start`.
- ESM import errors: generator `importFileExtension = "ts"`, or drop `"type": "module"`. TS 6 problems: fall back to 5.9.3. Vitest 5 problems: fall back to 4.1.x.
- Migrate drift from hand-written SQL: the service runs `SELECT public.next_claim_number()` inside the same `withTx` as the INSERT and passes the result; never use `nextval` plus JS formatting (D-11, BUG-1). Write partial indexes as hand SQL.
- Triggers misbehaving under Prisma: **gate at the end of D2** (passed), then switch to Plan B (D-13).

**Links.** [01 stack, Docker, compose](docs/design/01-architecture-and-stack.md) · [03 roles, triggers, migrations](docs/design/03-data-model-and-integrity.md) · [07 harness](docs/design/07-testing.md)

---

### P1: Identity + request spine (D2 PM Wed 14 to D3 AM Thu 15 Oct)

**Status: Done (2026-10-14).** Verified: `pnpm verify` exits 0 (unit 11/11: TC-U08, TC-U10, TC-U11; integration 41 + 1 P3 todo: TC-I00 to TC-I08). `docker compose down -v && up --build --wait` is healthy and the migrate job seeds reference data plus the 9-person cast. `/api/v1/auth/me` without a cookie returns a 401 envelope whose `requestId` appears in the access log. Login → me → logout → 401 works; pages redirect to `/login?next=…`. A broken `APP_BASE_URL` makes the container exit 1. `pnpm build` works with no `.env`. Open: the Next 16.4.x security bump (no 16.4.x newer than 16.4.0 is published yet; re-check before release; fallback 16.3.8) and the optional 'demo accounts' hint on the login page.
Small deviations: `resetDb()` calls `restoreReference()` *before* deleting `tmp.%` users (FK RESTRICT); `tests/helpers/factories.ts` starts in P1 with `makeUser`; `EXPORT_BATCH_SIZE` min lowered to 1 so tests can use 3 (07 §3.2).

**Goal.** Every later route gets authentication, CSRF, validation, error mapping and logging for free, and the §6 "every route authenticated" test exists before the first business route.

**Why now.** If the route-inventory test exists before the routes do, auth can never be forgotten later: every new `route.ts` is enumerated and probed automatically.

**Split.** D2 PM: the backend spine (env, logging, `defineRoute`, errors, health rewrap), sessions, the auth routes and the seed; TC-I01, TC-I02. D3 AM: CSRF, the login page, shell, proxy and api-client, the scaffold-page cleanup; TC-I03 to TC-I05; the P1 exit.

**Tasks**

*Docs-DevOps*
- [ ] As its own commit, bump `next`, `@next/env` and `eslint-config-next` to the 16.4.x out-of-band security patch, then run `pnpm verify`. Fallback: the patched 16.3.x line.
- The CI workflow (`.github/workflows/ci.yml`) moved to P8; it was already cut item 6.
- [x] ESLint flat config with `no-restricted-imports` zones per D-03, and bans on `'use server'`, `'use cache'`, `$queryRawUnsafe` and `$executeRawUnsafe`. Done in P0 (`eslint.config.mjs`); the pages zone uses the regex `'^@/server(?:$|/(?!auth/rsc$))'` (see the P0 deviations).
- [x] `package.json` scripts per the contract: `dev`, `build`, `start`, `typecheck`, `lint`, `format:check`, `db:*`, `test:*`, `verify`, `verify:integrity`, `policy:activate-tier`, `perf:*`, `compose:*`. Scripts that import `src/server/**` run under `tsx --conditions=react-server`, because every file there starts with `import 'server-only'`: `"policy:activate-tier": "tsx --conditions=react-server scripts/policy-activate-tier.ts"`, and the same flag on `verify:integrity`, `perf:seed` and `perf:explain`.

*Backend*
- [x] `src/server/env.ts`: a lazy, memoized Zod `env()`. When `APP_ENV` is staging or production it requires `SEED_ON_START=false`, `DEMO_MODE=false`, no `SEED_DEMO_PASSWORD` and an https `APP_BASE_URL`.
- [x] `src/instrumentation.ts` runs `env()`, then the forbidden-variable check when `NODE_ENV=production`, then `assertRuntimeRole()`. Steps 1–3 already run from P0; step 4, `assertPolicyLoadsWellFormed()`, joins in P3.
- [x] `src/server/logging/logger.ts` (pino 10.4, label levels, redaction, AsyncLocalStorage mixin) and `src/server/http/request-context.ts`.
- [x] `src/server/http/define-route.ts` (`defineRoute`, `ROUTE_META`), `public-routes.ts` (`PUBLIC_ROUTES`), `csrf.ts` and `call-meta.ts` (`callMeta(req)` → `{ ip, userAgent }`, used for `sessions.user_agent` and the access log).
- [x] Rewrap `src/app/api/health/{live,ready}/route.ts` in `defineRoute({ auth: 'public' })`, so TC-I01 finds `ROUTE_META` on them.
- [x] `src/server/errors/{codes.ts, app-error.ts, map-error.ts}` and `src/shared/errors.ts`. Mapping is by SQLSTATE and Prisma code only; 5xx bodies are generic.
- [x] Auth modules:
  - `src/server/auth/{password.ts, session.ts (createSession, authenticate), cookie.ts (sessionCookieName), rsc.ts (getActor), actor.ts}`.
  - `users.repo.ts`, `sessions.repo.ts`, `auth.service.ts`.
- [x] Routes:
  - `POST /api/v1/auth/login` (200 `{data:{user}}` + Set-Cookie; identical 401 `INVALID_CREDENTIALS`).
  - `POST /api/v1/auth/logout` (204).
  - `GET /api/v1/auth/me` (`MeDto`).
  - Catch-all `src/app/api/v1/[...path]/route.ts` → 404 `ROUTE_NOT_FOUND`.

*DB / seed*
- [x] `prisma/seed.ts` + `prisma/seed-personas.ts`, split in two parts:
  - `seedReference()`: departments ENG, FIN and EXEC, plus 10 active categories and the inactive `LEGACY_PER_DIEM`, written with `INSERT … ON CONFLICT (code) DO NOTHING`. It runs in every environment. Tiers join it in P3, when their table exists.
  - The cast: the nine-person `@acme.test` cast, with argon2id hashes of `SEED_DEMO_PASSWORD`. Idempotent, and refuses non-`.test` emails or staging/production.
  - For tests, `seed-personas.ts` also exports `seedReferenceAndCast(url, { password })` and `restoreReference(sql)` (cast flags only for now; tiers are added in P3).
- [x] Wire `seed` and `release` into the tools entrypoint. `release` runs `seedReference()` on **every** run, whatever `SEED_ON_START` says. The cast (and, from P3, the demo claims C01–C12) runs only when `SEED_ON_START=true` and `users` is empty. The P0 stub in `docker/tools/entrypoint.sh` still calls `seed` only when `SEED_ON_START=true`: make that call unconditional and move the `SEED_ON_START` check inside `seed.ts`. Update the `.env.example` comment on `SEED_ON_START` to match (01 §9.3).

*Frontend (D3 AM)*
- [x] Delete the scaffolded `src/app/page.tsx`, which would clash with `(app)/page.tsx` ("two parallel pages resolve to /"). Add `(app)/page.tsx` = `redirect('/claims')`, `src/app/not-found.tsx`, `global-error.tsx` and `(app)/error.tsx`.
- [x] The root `src/app/layout.tsx` renders `<Providers>` (QueryClient and Toaster, [05 §2](docs/design/05-frontend.md)), so `/login` gets them too.
- [x] `src/app/(auth)/login/page.tsx`.
- [x] `src/app/(app)/layout.tsx`: it only calls `getActor()`, redirects to `/login` when that returns null, and renders the navigation driven by the `MeDto` flags.
- [x] `src/lib/api-client.ts` (`apiFetch`, `ApiError` carrying `requestId`) and `src/lib/query-keys.ts`. A global 401 handler clears the cache and redirects to `/login`.
- [x] `src/proxy.ts`: optimistic redirect using `sessionCookieName()`. Its matcher excludes `/api`.

*Tests*
- [x] Helpers:
  - `tests/helpers/http.ts` (`callRoute`) and `tests/helpers/auth.ts` (`createSession`, `asPersona`).
  - `tests/helpers/route-manifest.ts` with `EXPECTED_ROUTES`. P1 holds 12 keys: login, logout, me, the two health probes and the 7 catch-all methods. Each later phase appends its own keys; the final list has 29.
  - `global-setup.ts` generates a random demo password, passes it to `seedReferenceAndCast(ownerUrl, { password })` and calls `project.provide('demoPassword', pw)`, so TC-I02's successful login has a known password without any `.env`.
  - `resetDb()` calls `restoreReference(sql)`.
  - `global-setup.ts`: remove the P0 `<db>_shadow` database and the `shadowUrl` it provides. The drift rule (D-37) needs no shadow DB.
- [x] TC-I01 (whole file; it asserts `expect(routes.map(r => r.key)).toEqual(expect.arrayContaining(EXPECTED_ROUTES))` instead of a fixed count) and TC-I02 (whole file).
- [x] TC-I03 › "POST with a cross-site Origin returns 403 CSRF_REJECTED", "requests without an Origin header are allowed", "JSON routes reject non-JSON content types with 415".
- [x] TC-I04 and TC-I05 (whole files). For TC-I05 › "a DB-backstop error is logged at error with defense=db", use a test-only route module under `tests/helpers/` (outside the TC-I01 glob) that throws the recorded `DriverAdapterError` shape with code `'UC012'`. Assert exactly one `db.backstop` line at level error with `defense:'db'` and `sqlstate:'UC012'`.
- [x] TC-I06 › "assertRuntimeRole rejects the owner role and accepts expense_app".
- [x] TC-U08 and TC-U11. TC-U10 is already done (P0, 4/4).

**Deliverables.** Browser login lands on the app shell. Every route, including the two health probes, is wrapped by `defineRoute`.

**Exit criteria.**
- The tests listed above are green.
- A lint fixture importing `@/generated/prisma` from `src/app` fails `pnpm lint` (already true since P0: TC-U10).
- The container exits non-zero when `.env` is broken.

**Gate (end of D2).** If TC-I00 is still red, switch to Plan B (D-13): view `claims_with_totals` plus an immutable, verified `claim_submissions.total_minor`. The P2 desync test then asserts "there is no mutable stored total, and submitted totals are verified at insert". **Passed on D2 AM:** TC-I00 (a) to (e) are green in P0.

**Walkthrough evidence.**
- `curl -i localhost:3000/api/v1/auth/me` returns a 401 envelope with a `requestId`. `docker compose logs app | grep <requestId>` shows the same id.
- The route-inventory test output.

**Risks & fallback.**
- The security release turns out to be more than a bump: stay on patched 16.3.x.
- `register()` throwing does not stop the server: rely on the explicit `process.exit(1)`, verified here.

**Links.** [04 authn, CSRF, pipeline, errors](docs/design/04-security-and-api.md) · [06 logging](docs/design/06-cross-cutting.md) · [01 env, CI, lint](docs/design/01-architecture-and-stack.md) · [05 shell, api-client](docs/design/05-frontend.md)

---

### P2: Draft claims + total integrity (D3 PM Thu 15 to D4 AM Fri 16)

**Status: Done (2026-10-14).** Verified: `pnpm verify` exits 0 (unit 32 + 1 todo; integration 85 + 7 todos for later phases). TC-I12 (desync, incl. COPY/MERGE/overflow) and TC-I13 (concurrency: writer 2 waits on `Lock/transactionid`, final total 300) are green. The P2 form of TC-I17 is green: `findClaimForActor` sends exactly one SELECT with `"claimant_id"` in its WHERE, and the 404 equals the random-UUID 404. `pnpm verify:integrity` prints 0 rows; as `expense_app` in psql, `UPDATE claims SET total_minor = 1` raises UC003. Compose rebuilt and healthy; `pnpm build` works with no `.env`.
Notes: PUT is last-write-wins with no claim `version` (D-51), so a stray `version` key is a 422. Line items travel as `{ id?, expenseDate, categoryId, amountMinor, description, merchant? }` (amounts in paise; the form converts typed decimals). Unknown query params named like server-owned fields return 422 `READ_ONLY_FIELD` rather than `VALIDATION_FAILED` (still 422; optional follow-up). TC-I24 forces one fixture to SUBMITTED with owner SQL until P3 adds `submitAs`. TC-C01 needs jsdom + Testing Library (install in P4).

**Goal.**
- A claimant can create, edit and delete drafts end to end.
- The §3.1/§6 desync proof is complete, including concurrency.
- The **first form of the sharpest authz test** is green.

**Why now.** The total is the POC's core hard case. Proving it before any workflow exists means every later feature sits on a verified invariant. From here on, the global `afterEach(assertTotalsInSync)` turns every integration test into a desync probe.

**Split.** D3 PM: shared code, repositories, the service and routes; TC-I09, TC-I10, TC-I12. D4 AM: TC-I13, TC-I14, TC-I17 (P2 form), TC-I24 and the `ClaimForm` only. The `/claims` list UI is built on D6 AM as the shared `PagedTable` (see P4), and TC-C01 moves to D6 PM.

**Tasks**

*Shared*
- [x] `src/shared/policy.ts` (the policy constants).
- [x] `money.ts` (`parseMoneyToMinor`, `formatMinor`), `dates.ts` (`businessDayRangeToUtc`, `todayInBusinessTz`), `cursor.ts`, `enums.ts`.
- [x] Strict `schemas/*`: `CreateClaimInput`, `ReplaceClaimInput`, `LineItemInput`, `ClaimListQuery`.
- [x] `dto/*`: `ClaimSummary`, `ClaimDetail`, `CategoryDto`.

*Backend*
- [x] `src/server/repositories/claim-visibility.ts` (C-26):
  - `claimVisibilityWhere(actor)`: owner OR FINANCE for now. The approver-step clause arrives in P4.
  - `findClaimForActor(actor, claimId, select)`: a single SELECT with `{ AND: [{ id }, claimVisibilityWhere(actor)] }` through `getDb()`, with no tx (it reads after commit).
- [x] `claims.repo.ts`:
  - `lockOwnedClaim(tx, actor, claimId)`: `FOR NO KEY UPDATE`, returning `LockedClaim | null`; the service throws.
  - Keyset `listMine`.
- [x] `line-items.repo.ts` (signatures `(tx, actor, claimId, childId?)`) and `categories.repo.ts`.
- [x] `src/server/authz/claim-policy.ts`: pure `decide(actor, facts)` → `allowedActions`.
- [x] `claims.service.ts`, every function `(ctx: ServiceCtx, ...ids, input?)` (C-26):
  - `createClaim`: an empty DRAFT.
  - `getClaim`.
  - `replaceClaim`: the PUT replace-set, in the C-25 write order minus the receipt-key steps, which P6 adds. A foreign line id → 404 `LINE_ITEM_NOT_FOUND` before any write.
  - `deleteDraft`: only when `current_revision = 0`, otherwise 409 `CLAIM_HAS_HISTORY`.
- [x] Routes (append their keys to `EXPECTED_ROUTES`):
  - `GET /api/v1/categories`.
  - `GET` and `POST /api/v1/claims`.
  - `GET`, `PUT` and `DELETE /api/v1/claims/:claimId`.
- [x] `scripts/verify-integrity.ts` → `pnpm verify:integrity` (run under `tsx --conditions=react-server`). It reads `v_claim_total_drift` and exits 1 if any row exists.

*Frontend*
- The `/claims` list UI moves to D6 AM, where it is built once as the shared `PagedTable` for `/claims` and `/approvals` (see P4). Until then, TC-I24 covers the list API.
- [x] `/claims/new` and `/claims/[id]`: a `ClaimForm` built with:
  - RHF `useFieldArray`, keeping the server id as `lineItemId`, and `zodResolver`.
  - Money inputs with `inputMode="decimal"`, plus native date and select inputs.
  - A `saved-total` labelled "calculated by the database" and an `unsaved-total` preview.
  - `applyServerIssues` to map `details.issues[].path` onto fields.
- [x] `ClaimDetailView`: read-only rendering when `allowedActions` lacks `EDIT`. `NotFoundView kind="claim"` on 404.

*Tests*
- [x] `tests/helpers/factories.ts` per [07 §5.3](docs/design/07-testing.md): `makeDraft` and `makeUser`, calling services with ``ctx = (actor) => ({ actor, requestId: `test-${randomUUID()}` })``.
- [x] TC-U01, TC-U02, TC-U05, TC-U07.
- [x] TC-U04 › "decide() is exhaustive over status × relationship × action", "allowedActions for FINANCE is always empty", "allowedActions offers DELETE only for never-submitted drafts".
- [x] TC-I09 (all but "DELETE of a claim that was ever submitted returns 409 CLAIM_HAS_HISTORY", which lands in P3) and TC-I10 (whole file).
- [x] **TC-I12** `integrity/total-desync.int.test.ts` (the whole umbrella `describe`, including COPY, MERGE and overflow cases).
- [x] **TC-I13** `integrity/total-concurrency.int.test.ts` (whole file).
- [x] TC-I14 › "PUT on my claim containing another claim's line id returns 404 LINE_ITEM_NOT_FOUND and changes nothing", "the victim's rows and total are byte-for-byte unchanged".
- [x] TC-I24 (whole file). TC-C01 moves to D6 PM (listed under P4).
- [x] **TC-I17 first form (P2 form)** in `tests/integration/authz/out-of-queue-by-id.int.test.ts`. Neha is an approver, and Asha's claim is not routed to her. P2 has no routing yet and the predicate is owner OR FINANCE, so this form proves owner scoping:
  - `beforeEach`: `c02 = makeDraft('asha', { lines: [{ amountMinor: 800_000 }] })`, never submitted; positive control `makeDraft('neha')`. Only `claimRoute` is imported.
  - "approver requesting a claim outside their queue by id is refused at the point of the query": `findClaimForActor(neha, c02.id, { id: true })` returns `null`, exactly one claims SELECT was sent, and it contains `"claimant_id"` (the predicate is in the WHERE).
  - "GET /claims/:id returns 404 CLAIM_NOT_FOUND identical to the 404 for a random UUID": the 404 body equals the random-UUID 404.

**Deliverables.**
- The draft-claim vertical slice: DB, API, UI and tests.
- The integrity suite.
- `pnpm verify:integrity`.

**Exit criteria (gate: end of D4).**
- TC-I09 (except the CLAIM_HAS_HISTORY case), TC-I10, **TC-I12**, **TC-I13**, TC-I14 (PUT cases), TC-I24, TC-U01, TC-U02, TC-U05 and TC-U07 are green.
- **TC-I17's first two tests (P2 form) are green.**
- `pnpm verify:integrity` prints 0 rows.
- In the UI, the saved total changes only after Save.

**Walkthrough evidence.**
- In psql as `expense_app`, `UPDATE claims SET total_minor = 1 WHERE …` raises UC003.
- `pnpm verify:integrity` shows 0 rows.
- The TC-I13 run shows the second writer waiting in `pg_stat_activity` and a final total of 300.
- The SQL Prisma generates for `findClaimForActor`, with the visibility predicate inside the WHERE.

**Risks & fallback.**
- The editor overruns (the whole frontend budget is about 22–25 h): ship a plain table editor first and polish it in BUF.
- A per-row `updateMany` count ≠ 1: throw `CONFLICT` rather than ignore it.
- int4 overflow (22003): it maps to 422, covered by TC-I12 › "50 lines at the per-line cap exceed the claim cap and return 422, never 500".

**Links.** [03 total integrity, triggers](docs/design/03-data-model-and-integrity.md) · [04 validation, scoped queries, PUT contract](docs/design/04-security-and-api.md) · [05 claim editor](docs/design/05-frontend.md) · [07 the two sharpest tests](docs/design/07-testing.md)

---

### P3: Submit, routing, audit (D4 PM to D5 AM Mon 19)

**Status: Done (2026-10-14).** Verified: `pnpm verify` exits 0 (unit 43 + 1 todo, incl. TC-U03 11/11; integration 106 + 9 todos for later phases, incl. TC-I15 9/9 and the P3 cases of TC-I09, TC-I16 and TC-I23; TC-I07/TC-I08 cover the four workflow tables). `pnpm build` works with no `.env`. `docker compose down -v && up --build --wait` is healthy: 4 migrations, reference data with tiers (L4_CFO inactive), the cast and demo claims C01 (DRAFT) and C02 (PENDING ravi, SeedClock-backdated). Live: ₹10,000.00 → [ravi]; ₹10,000.01 → [ravi, meera]; the `claim_events.request_id` equals the response `x-request-id`; after `pnpm policy:activate-tier L4_CFO` a ₹2,50,000 claim routes to [ravi, meera, vikram, deepa] (the earlier one keeps 3 steps), then `--off` restores the policy. `pnpm verify:integrity` prints 0 rows. Raw-SQL forgeries in tests go through `tests/helpers/raw-submit.ts` (the SQL proof's C-25 fixture with hooks).

**Goal.** A claim can be submitted. It gets an amount-routed chain built from data rows, an immutable snapshot, and a structured trace.

**Why now.** Decisions (P4), recall (P5) and the export (P7) all read submissions, steps and events, so the workflow migration and the single audit writer must exist first.

**Split.** D4 PM: the `workflow` migration, the tiers in `seedReference()`, the boot policy check, `buildChain` + TC-U03. D5 AM: the submit service, `recordEvent`, the stepper UI; TC-I15, TC-I16, TC-I23 (submit).

**Tasks**

*DB*
- [x] Migration `…_workflow`:
  - Enums `approval_step_status`, `approver_resolver`, `claim_event_type` and `event_actor_role`.
  - Tables `approval_policy_tiers`, `claim_submissions`, `approval_steps` and `claim_events`.
  - Then the hand-written block, copied in [03 §16.5](docs/design/03-data-model-and-integrity.md#16-verified-sql-migration-by-migration) order: the workflow CHECKs; #1 `assert_claim_editable` v2 (`CREATE OR REPLACE`, the snapshot freeze that fixes BUG-2); #6 `claim_submissions_verify` v1; #7 `approval_steps_guard`; #8 `forbid_mutation`; #9 `assert_transition_audited`; #4 `claims_guard` v2 (`CREATE OR REPLACE`); triggers; grants.
  - Partial indexes `approval_steps_pending_queue_idx` and `approval_steps_one_pending_per_submission`, plus the remaining indexes.
  - Explicit grants: SELECT only on tiers; SELECT and INSERT only on submissions and events; no DELETE on steps.
- [x] Add the tiers to `seedReference()`: `L1_MANAGER`, `L2_SKIP_LEVEL` and `L3_SENIOR_LEADER` active; `L4_CFO` inactive, designated to `deepa.menon@acme.test` and inserted only if deepa exists. `INSERT … ON CONFLICT (code) DO NOTHING`, so an activated L4 is never reset. Because `release` runs `seedReference()` every time, the existing dev volume gets the tiers too. `assertPolicyWellFormed` runs at seed time. Extend `restoreReference` to the tiers.
- [x] `scripts/policy-activate-tier.ts` → `pnpm policy:activate-tier <CODE>` (under `tsx --conditions=react-server`), run as owner:
  - First lines: `import nextEnv from '@next/env'; nextEnv.loadEnvConfig(process.cwd())` (a default import; see the P0 deviations); then `process.env.DATABASE_URL = process.env.MIGRATE_DATABASE_URL` (exit 1 if unset); then dynamic-import `policy.ts`.
  - One transaction: SELECT all tiers FOR UPDATE → set `is_active` → `assertPolicyWellFormed` → COMMIT.

*Backend*
- [x] `src/server/routing/build-chain.ts` (pure `buildChain`).
- [x] `src/server/routing/policy.ts`: `assertPolicyWellFormed`, and `assertPolicyLoadsWellFormed()` (`tiersRepo.listAll()` as `expense_app` → `assertPolicyWellFormed`). Call `assertPolicyLoadsWellFormed()` as step 4 in `src/instrumentation.ts`.
- [x] `src/server/routing/org-loader.ts`: a recursive CTE over `manager_id`.
- [x] `src/server/audit/events.ts` (a Zod discriminated union over the 6 event types) and `record-event.ts` (`recordEvent(tx, ctx, event)`).
- [x] `submissions.repo.ts`, `steps.repo.ts`, `events.repo.ts`, `tiers.repo.ts`.
- [x] `SeedClock` (`interface SeedClock { now(): Date }`, `ServiceCtx.clock?`, [02 §9](docs/design/02-domain-and-workflow.md)): pass `ctx.clock` through `createClaim`, `replaceClaim`, `submit` and `recordEvent`. When present, services pass `clock.now()` as `created_at` (create), as `claims.submitted_at`, `claim_submissions.submitted_at` and level-1 `activated_at` (submit), and as `claim_events.occurred_at`. For `expense_app` the DB overwrites them (D-23); only the owner-run seed keeps them.
- [x] `lifecycle.service.ts` `submit(ctx, claimId)`, in this order:
  1. Lock the claim.
  2. Check the status.
  3. Load the lines: none → `NO_LINE_ITEMS`; an inactive category → `CATEGORY_INACTIVE`.
  4. Load the tiers and the org.
  5. `buildChain`; if unresolvable → `ROUTING_UNRESOLVABLE`.
  6. INSERT the submission with its snapshot.
  7. INSERT the steps: level 1 PENDING, the rest WAITING.
  8. UPDATE the claim.
  9. `recordEvent(CLAIM_SUBMITTED | CLAIM_RESUBMITTED)`.
  10. After commit, log `claim.submitted`.
- [x] Route `POST /api/v1/claims/:claimId/submit` (append its key to `EXPECTED_ROUTES`). Populate `ClaimDetail.approval`.
- [x] Start `prisma/seed-claims.ts` through the real services with `ctx.clock` set: C01 (draft), C02 (₹8,000 PENDING ravi), C03 (₹25,000 L1 approved, PENDING meera). C03 needs approve, so complete it in P4. Export `seedDemoClaims()` for TC-I16. Demo claims run only with the cast (`SEED_ON_START=true` and an empty `users` table).

*Frontend*
- [x] Submit and "Save & submit" buttons, rendered from `allowedActions`.
- [x] Status badge (`claim-status`).
- [x] Approval-chain stepper showing level, tier label, approver and status.
- [x] Specific messages for `NO_LINE_ITEMS` and `ROUTING_UNRESOLVABLE`.

*Tests*
- [x] `factories.ts`: add `submitAs`.
- [x] TC-U03 (whole file) and TC-I15 (whole file).
- [x] TC-I09 › "DELETE of a claim that was ever submitted returns 409 CLAIM_HAS_HISTORY".
- [x] TC-I16 › "₹10,000.00 → [ravi]; ₹10,000.01 → [ravi, meera]; ₹50,000.01 → [ravi, meera, vikram]", "activating L4 via owner SQL routes ₹2,50,000 to [ravi, meera, vikram, deepa] with no code change", "vikram's ₹8,000 claim routes to deepa as FALLBACK", "expense_app cannot change approval_policy_tiers".
- [x] TC-I23 › "submit, approve (intermediate and final), reject and recall each write exactly one typed event" (submit case), "event request_id equals the response x-request-id", "event actor is the authenticated actor", "a failed transition writes no event", "a status change without an event fails at COMMIT with UC015", "claim_events rejects UPDATE and DELETE (42501 / UC007)".
- [x] Extend TC-I07 and TC-I08 to the four new tables.

**Deliverables.** A submit vertical slice, the routing engine, snapshots and the audit writer.

**Exit criteria.**
- TC-U03 and TC-I15 are green; the TC-I09, TC-I16 and TC-I23 cases listed above are green.
- After `pnpm policy:activate-tier L4_CFO`, a ₹2,50,000 claim gets 4 steps with no code change. This delivers §8 bullet 1 inside core.
- With boot step 4 wired and the seed extended, `docker compose down -v && docker compose up --build --wait` is healthy.

**Walkthrough evidence.**
- The boundary tests: ₹10,000.00 routes to 1 step and ₹10,000.01 to 2.
- One `claim_events` row shown as JSON, including its `request_id`.
- The L4 activation demo.

**Risks & fallback.**
- Prisma rejects the double relation on `approval_steps` (the composite FK plus a plain `claim_id` FK): drop the plain FK and reach the claim via the submission.
- PL/pgSQL takes longer than planned: write the TC-I15 and TC-I23 cases first (test-first), and reuse the deferred-constraint pattern already proven by `assert_claim_total_consistent` in P0.

**Links.** [02 routing, lifecycle, audit catalogue](docs/design/02-domain-and-workflow.md) · [03 workflow SQL](docs/design/03-data-model-and-integrity.md)

---

### P4: Approver queue + decisions, the authorization slice (D5 PM to D6 Tue 20)

**Status: Done (2026-10-14).** Verified: `pnpm verify` exits 0 (unit 44, incl. TC-U04's submissionOutcome case; component 5 = TC-C01, with the component project now on `@vitejs/plugin-react`, jsdom and `TZ=America/Los_Angeles`; integration 170 + 7 todos for P5/P6, incl. TC-I17's routed-approver form (history, recall and receipt rows todo), TC-I18's 42 F1 rows plus the finance case, TC-I19 10/10, TC-I20's parallel approvals (green 3 runs in a row, plus the verify run), TC-I25 6/6, TC-I16's level-activation case, and TC-I23's approve/reject events and UC015 decision-actor case). `pnpm build` works with no `.env`. `docker compose down -v && up --build --wait` is healthy and seeds C01–C05, C08, C11 and C12 (C08, C11 and C12 are EXP-2026-000006 to -000008 until P5 inserts C06 and C07). Live: Ravi's Pending tab lists C02; Asha's new ₹25,000 claim is not in Meera's queue while WAITING, and after Ravi approves it is there as level 2 of 2; Neha gets 404 on GET C02 and 403 `NOT_IN_YOUR_QUEUE` on approving it (the same body as for a random id); Farah gets 403 `FORBIDDEN`; a second approve by Ravi gets 409 `ALREADY_DECIDED`. `EXPLAIN (ANALYZE)` of the pending queue as `expense_app`: Index Scan on `approval_steps_pending_queue_idx` with the keyset and date range as the Index Cond, and no Sort. `pnpm verify:integrity` prints 0 rows. Backdated decisions in tests go through `ownerDecideAt` (owner SQL in the C-25 order, `tests/helpers/raw-submit.ts#rawDecide`). The `NOT_IN_YOUR_QUEUE` and `REVISION_MISMATCH` toasts are written but can only be triggered in the UI once recall exists (P5).

**Goal.**
- Approvers see only what is routed to them.
- They can act only on their own PENDING step of the current revision.
- **The §6 sharpest test passes for routed approvers:** the approve/reject cases by the end of D5, and the whole test by the end of D6 apart from the history and recall rows (P5) and the receipt rows (P6), which arrive with their routes.

**Why now.** Decisions are the authorization heart of the POC, and P5 (recall races, rejection history) and P7 (approved claims to export) need real decisions to exist.

**Split.** D5 PM: the visibility EXISTS clause, `lockClaimRoutedToMe`, approve/reject; the TC-I17 approve/reject cases. D6 AM: the `/approvals` endpoint, the shared `PagedTable` for `/claims` and `/approvals`, the review page. D6 PM: TC-I18 (fixture F1), TC-I19, TC-I20 (parallel approvals), TC-I25, TC-C01; seed C04/C05/C08/C11/C12.

**Tasks**

*Backend*
- [x] Extend `claimVisibilityWhere(actor)` with `EXISTS (approval_steps WHERE approver_id = me AND status IN ('PENDING','APPROVED','REJECTED'))`, supported by `approval_steps_visibility_idx`.
- [x] `claims.repo.ts#lockClaimRoutedToMe(tx, actor, claimId)`: `FOR NO KEY UPDATE OF c`, with the PENDING EXISTS clause. It returns `LockedClaim | null`; the service throws (C-26).
- [x] `approvals.service.ts` `approve(ctx, claimId, input)` and `reject(ctx, claimId, input)`, in the documented order:
  - The role gate runs before the transaction.
  - If no PENDING step is found: 409 `ALREADY_DECIDED` when the caller decided the current revision, otherwise 403 `NOT_IN_YOUR_QUEUE`.
  - A stale `revision` → 409 `REVISION_MISMATCH`.
  - Approve sets the next level PENDING, or sets the claim APPROVED.
  - Reject sets REJECTED, cancels the WAITING steps and sets the claim REJECTED.
  - 40001/40P01/P2034 are retried up to 2 times, then 409 `CONFLICT`.
  - Pass `ctx.clock` through both: when present, `clock.now()` becomes `decided_at`, the next level's `activated_at`, `approved_at`/`rejected_at` and `cancelled_at`.
- [x] Routes `POST /api/v1/claims/:claimId/approve` and `/reject`, gated by `canApprove && role ≠ FINANCE`.
- [x] `GET /api/v1/approvals` (`ApprovalQueueQuery`):
  - PENDING: keyset on `activated_at ASC, id ASC` using `approval_steps_pending_queue_idx`.
  - Decided: `decided_at DESC, id DESC` using `approval_steps_approver_history_idx`.
- [x] Append the three new route keys to `EXPECTED_ROUTES`.
- [x] Seed claims C03 (finish), C04 (APPROVED, 3 steps), C05 (REJECTED by ravi), C08 (Arjun → neha), C11 (Vikram → deepa FALLBACK) and C12 (Farah's claim, approved by deepa).

*Frontend*
- [x] The shared `PagedTable` (D6 AM), built once for `/claims`, `/approvals` and later `/finance/claims` (05: "one list component reused 3×"). `/claims` comes from P2: status and date filters live in the URL via `src/lib/use-url-query.ts` over `ClaimListQuery`, with `useInfiniteQuery` and a "Load more" button.
- [x] `/approvals` with Pending and Decided tabs (`?status=PENDING` by default; Decided = `APPROVED,REJECTED`) and From/To IST date inputs bound to `from`/`to` in the URL via `use-url-query` ("Routed to me between" on Pending, "Decided between" on Decided, per [05 §10.3](docs/design/05-frontend.md)), reusing the list component.
- [x] `/approvals/[claimId]`, reusing `ClaimDetailView`:
  - An approve confirmation that names the next approver.
  - A reject dialog that requires a 10..1000-character reason.
  - Both send `revision`.
- [x] Toasts for `NOT_IN_YOUR_QUEUE`, `ALREADY_DECIDED` and `REVISION_MISMATCH` that refetch. `ForbiddenView` when the role doesn't match the section.

*Tests*
- [x] `factories.ts`: add `approveAs` and `rejectAs`, plus `ownerDecideAt` and the `at` option of `approveAs`: owner SQL that runs the C-25 approve/reject order with supplied `decided_at`/`approved_at`/`occurred_at` (and the next level's `activated_at`). TC-I25's IST boundary case needs it here; TC-I28 reuses it in P7.
- [x] **TC-I17 routed-approver form** (D5 PM). Switch to the [07 §8](docs/design/07-testing.md) `beforeEach` (C02 and C08 via `submitAs`) and add the step-branch regex. The imports and `attempts()` cover only GET/PUT/DELETE claim, submit, approve and reject, and the "nothing changes" snapshot query leaves out `receipts`. Add "approve and reject return 403 NOT_IN_YOUR_QUEUE" and "nothing changes: step statuses, the claim row and claim_events are untouched" (neha against C02). P5 adds the history and recall routes; P6 adds the three receipt routes and the `receipts` column, completing "history and receipt routes for that claim return 404".
- [x] TC-I18 over fixture F1 with actions {GET, PUT, DELETE, submit, approve, reject}; TC-I19 (whole file); TC-I20 › "10 parallel approvals of one step produce exactly 1 success and 1 event"; TC-I25 (whole file). The recall and history columns, fixture F2 and the approve-vs-recall race land in P5.
- [x] TC-C01 (whole file; carried over from P2, D6 PM).
- [x] TC-U04 › "submissionOutcome derives IN_APPROVAL, APPROVED, REJECTED and RECALLED from steps".
- [x] TC-I16 › "only level 1 is PENDING at submit; approving level n activates n+1".
- [x] TC-I23 › "submit, approve (intermediate and final), reject and recall each write exactly one typed event" (approve and reject cases; recall added in P5), "a decision event whose actor is not the step approver fails at COMMIT with UC015".

**Deliverables.** The approver queue, decisions, the review UI and the authorization test set (recall, history and receipt rows follow in P5 and P6).

**Exit criteria (gate: end of D6).**
- End of D5: the TC-I17 approve/reject cases are green.
- TC-I17 (except the history, recall and receipt subtests), TC-I18 (fixture F1), TC-I19, TC-I20 › "10 parallel approvals of one step produce exactly 1 success and 1 event", TC-I25 and TC-C01 are green.
- With the seed extended, `docker compose down -v && docker compose up --build --wait` is healthy.
- If you are more than half a day behind, apply cut item 2 now (items 3–5 are already applied).

**Walkthrough evidence.**
- Run TC-I17 live, and show the SQL Prisma emits (the predicate is in the WHERE).
- `EXPLAIN` of the queue query: an Index Scan on the partial index.
- Ravi approves C03's predecessor step and Meera sees it in her queue.

**Risks & fallback.**
- Diagnosis branches multiply: treat the action × status table in [02](docs/design/02-domain-and-workflow.md) as the spec, and table-drive TC-I18 from it.
- Flaky race tests: run TC-I20 three times locally before closing the phase.

**Links.** [04 authz matrix, ladder](docs/design/04-security-and-api.md) · [02 decisions, concurrency](docs/design/02-domain-and-workflow.md) · [05 approvals UI](docs/design/05-frontend.md) · [07 sharpest test](docs/design/07-testing.md)

---

### P5: Reject, recall, resubmit, history, lock proof (D7 AM, Wed 21)

**Status: Done (2026-10-15).** Verified: `pnpm verify` exits 0 (unit 44, component 5, integration 210 + 5 todos, all of them P6 receipt cases: TC-I11's receipt upload/delete, TC-I14's two, TC-I17's receipt rows and TC-I22's receipt case). P5 tests: TC-I11 4/4, TC-I21 6/6, TC-I22 4/4, TC-I23's recall case and "GET /claims/:id/history returns ordered events to authorized viewers only", TC-I17's history and recall rows, TC-I18's recall and history columns plus fixture F2 (65 rows), TC-I20's approve-vs-recall race (forced with `gate()` + `waitForLockWaiters()`; green 3 runs in a row plus the verify run) and TC-I16's stored-approvers case (`seedDemoClaims()` run as expense_app, 12 submissions compared with `buildChain()`); TC-I09 also covers a recalled draft. `pnpm build` works with no `.env`. `docker compose down -v && up --build --wait` is healthy and seeds C01–C12 in order (C06 = EXP-2026-000006 … C12 = EXP-2026-000012); `approved_at AT TIME ZONE 'Asia/Kolkata'` reads 2026-09-30 23:59:30 for C09 and 2026-10-01 00:15:00 for C10. `scripts/demo/edit-approved.sh`: PUT, submit, recall and DELETE on C04 → 409 `CLAIM_LOCKED`, unchanged (exit 0). `scripts/demo/sql-attacks.sh` as expense_app: UC001, UC003, 42501 (`DISABLE TRIGGER`) and 42501 (`session_replication_role`) (exit 0). §7 Q3 live with curl on C05: REJECTED with `lastRejection` (Ravi, "Hotel invoice missing for 3 Oct") → PUT → resubmit (revision 2, [Ravi PENDING, Meera WAITING]) → history shows revision 1 REJECTED and revision 2 IN_APPROVAL, events CLAIM_SUBMITTED → CLAIM_REJECTED → CLAIM_RESUBMITTED (`previousRevision` r1); the stack was then reset to the clean seed. `pnpm verify:integrity` prints 0 rows. No new migration and no src fixes were needed. Not yet exercised in a browser: the rejection, recalled and locked banners, the recall dialog and the event list (checked by build, types, lint and a throwaway jsdom run only; TC-E covers them in P8).

**Goal.** §3.3 and §3.4 are demonstrable, and §7 Q2 and Q3 have runnable answers.

**Why now.** It depends on decisions (P4), and it is the content of two of the three §7 questions.

**Tasks**

*Backend*
- [x] `lifecycle.service.ts` `recall(ctx, claimId, input)` and the route `POST /api/v1/claims/:claimId/recall` (`RecallInput`). The `CLAIM_RECALLED` payload carries `cancelledSteps` and `approvedLevelsVoided`. Pass `ctx.clock` through recall (`cancelled_at`, `occurred_at`).
- [x] Resubmit through the same `/submit` from REJECTED → `CLAIM_RESUBMITTED` with `previousRevision`.
- [x] `GET /api/v1/claims/:claimId/history` (`ClaimHistory`):
  - Submissions with their snapshot, their outcome via `submissionOutcome` and their steps.
  - Events in order.
- [x] Append the recall and history route keys to `EXPECTED_ROUTES`.
- [x] `ClaimDetail.lastRejection`.
- [x] Finish `seed-claims.ts` (every history dated through `ctx.clock`):
  - C06: revision 1 ₹30,000 rejected by meera, resubmitted at ₹9,500.
  - C07: recalled after L1 approved.
  - C09: approved 2026-09-30 23:59:30 IST.
  - C10: approved 2026-10-01 00:15:00 IST.

*Frontend*
- [x] A rejection banner showing the reason, who rejected it and when (IST). It stays visible while a REJECTED claim is being edited.
- [x] A recall dialog that explains approvals will restart.
- [x] A locked banner on APPROVED claims.
- [x] The raw event list, grouped by revision (`timeline-event` items with `data-event-type`). Cut item 5 is applied up front, so there is no polished timeline UI.

*Tests*
- [x] `factories.ts`: add `recallAs`.
- [x] TC-I11 (whole file except the receipt upload/delete cases of "every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED", which land in P6) and TC-I21 (whole file).
- [x] TC-I22 (all except the receipt case, which comes in P6).
- [x] TC-I23 › the recall case of "submit, approve (intermediate and final), reject and recall each write exactly one typed event", and "GET /claims/:id/history returns ordered events to authorized viewers only".
- [x] TC-I17 › "history and receipt routes for that claim return 404" (history half; add the history and recall routes to the imports and `attempts()`).
- [x] TC-I18 recall and history columns, plus fixture F2 (the cancelled approver: Asha recalls).
- [x] TC-I20 › "approve racing recall: on the final level exactly one wins; on an intermediate level both succeed in lock order; status, steps and events agree".
- [x] TC-I16 › "stored approvers equal buildChain() for every seeded claim": the test calls `seedDemoClaims()` (exported from `prisma/seed-claims.ts`) itself, asserts `SELECT count(*) FROM approval_steps` > 0, then compares each submission's approver ids with `buildChain()`. (The integration DB seeds no demo claims, so without this the loop would pass over zero rows.)

*Docs-DevOps*
- [x] `scripts/demo/edit-approved.sh`: curl `PUT` on C04 → 409 `CLAIM_LOCKED`.
- [x] `scripts/demo/sql-attacks.sh`: psql as `expense_app` → UC001 (edit an approved line), UC003 (write the total), 42501 (`DISABLE TRIGGER`).

**Deliverables.** Recall, resubmit, history, the lock proof and both demo scripts.

**Exit criteria.**
- The listed tests are green, and both demo scripts print the expected codes.
- On the seeded compose DB, `SELECT approved_at AT TIME ZONE 'Asia/Kolkata'` for C09 and C10 returns 2026-09-30 23:59:30 and 2026-10-01 00:15:00 (the seed clock reached the DB).
- With the seed extended, `docker compose down -v && docker compose up --build --wait` is healthy.

**Walkthrough evidence.**
- The §7 Q2 sequence: UI (no edit buttons) → curl (409) → psql (UC001) → disable trigger (42501).
- The §7 Q3 sequence on C05: rejected → edit → resubmit → history shows both revisions.

**Risks & fallback.** This is a tight half-day, which is why cut item 5 (the raw event list instead of a timeline UI) is applied up front. Recall and history must not slip: TC-I18's F2 rows and the TC-I20 race depend on them.

**Links.** [02 recall/resubmission, preserved vs reset](docs/design/02-domain-and-workflow.md) · [03 lock triggers](docs/design/03-data-model-and-integrity.md) · [05 banners, timeline](docs/design/05-frontend.md)

---

### P6: Receipts per line item (D7 PM Wed 21 + D10 AM Mon 26)

**Status: Done (2026-10-15).** D7 noon gate passed: SeaweedFS 4.48 (`weed mini`, digest-pinned) is kept; the FS fallback was not needed (`FsReceiptStorage` stays as an adapter). Verified: `pnpm verify` exits 0 (unit 44, component 5, integration 223 with 0 todos: TC-I27 10/10, the receipt cases of TC-I11, TC-I14, TC-I17 and TC-I22, and the `receipts` rows of TC-I07/TC-I08). `pnpm build` works with no `.env`. `docker compose down -v && up --build --wait`: objectstore, postgres and app healthy; migrate exits 0 (5 migrations, seed, bucket `receipts` created); `/api/health/ready` reports `storage: ok`. Live with curl as asha: a 9.9 MiB PDF uploads to a DRAFT line (201) and downloads byte-identical (sha256 match; `attachment`, `nosniff`, `no-store`); 10 MiB + 1 byte → 413, a renamed .exe → 422; submit → 200 at revision 1 with the receipt's key and hash in the snapshot (#6 v2); upload after submit → 409 `CLAIM_NOT_EDITABLE`; upload to C04 → 409 `CLAIM_LOCKED`, and C04's `allowedActions` is `[]`. psql as expense_app: INSERT into `receipts` for C04 → UC001, DELETE FROM receipts on an approved claim that has a receipt → UC001, UPDATE → 42501. C04 has no seeded receipt, so `DELETE FROM receipts` on C04 itself matches 0 rows and raises nothing. `pnpm verify:integrity` prints 0 rows; the stack was then reset to the clean seed. The tests needed no src fixes. Not exercised in a real browser against the S3 stack (the UI was checked live on the fs driver).

**Goal.** Claimants attach receipts to each line through a real storage interface, and approved evidence can never change.

**Why now.** It needs lines (P2) and snapshots (P3). It is off the critical path: TC-E01 no longer attaches a receipt (that step moved to TC-E05), so nothing on D8–D9 waits for it. It is planned explicitly in two halves, D7 PM and D10 AM. If the D7 PM half slips, the whole phase moves to D10 AM: TC-I27, the receipt parts of TC-I11, TC-I14, TC-I17 and TC-I22, TC-E05 and the objectstore compose change land on D10, followed by the BUF re-run of e2e and the clean-clone rehearsal.

**Split.** D7 PM: the storage gate and probe, the objectstore service and ensure-bucket, the `receipts` migration, the storage adapters and sniffer, the routes. D10 AM: the receipt-key steps in `replaceClaim`/`deleteDraft`, the UI and the tests.

**Tasks**

*Docs-DevOps*
- [x] **D7 noon gate (30-minute timebox).** First the object-store probe moved here from P0: run `docker run chrislusf/seaweedfs:4.48 weed mini`, then put and get one object from a scratch script with `@aws-sdk/client-s3` (`forcePathStyle: true`, checksums `WHEN_REQUIRED`). Then add the `objectstore` service (`compose.yaml` already carries it commented out):
  - `chrislusf/seaweedfs:4.48`, `weed mini`.
  - Volume `objectstore:/data` and a healthcheck.
  - Port `127.0.0.1:${S3_HOST_PORT}:8333`.
  - If it works from the app, keep it.
  - Otherwise use the FS fallback, in full:
    - `RECEIPT_STORAGE_DRIVER=fs` and `RECEIPT_FS_DIR=/app/.data/receipts`.
    - Add the app volume `receipts:/app/.data/receipts` and a top-level `receipts: {}`.
    - Remove the `objectstore` service and its volume (or move it under `profiles: ["s3"]`), and drop it from `migrate.depends_on`.
    - Pass `RECEIPT_STORAGE_DRIVER` to `migrate`, and make `ensure_bucket` a no-op when it is `fs`.
    - In the Dockerfile runner, use `RUN mkdir -p .next .data/receipts && chown -R node:node .next .data`. Otherwise the named volume is owned by root and `FsReceiptStorage` fails with EACCES for uid 1000.
    - TC-E06 then leaves `objectstore` out of its service and port lists.
- [x] `scripts/ensure-bucket.ts` wired into the tools `release`. With the S3 driver, `migrate` depends on `objectstore` being healthy.

*DB*
- [x] Migration `…_receipts`:
  - The `receipts` table, with composite FK `(line_item_id, claim_id) → line_items(id, claim_id)`.
  - Function #10, `receipts_before_write`.
  - #6 `claim_submissions_verify` v2 (`CREATE OR REPLACE`): the v1 text with the three edits in [03 §16.6](docs/design/03-data-model-and-integrity.md#16-verified-sql-migration-by-migration), written out in full in the migration. Without it, v1's check `jsonb_path_exists(NEW.snapshot,'$.lines[*].receipts[*]')` raises UC016 on every submit that includes a receipt, which surfaces as a 500.
  - Index `receipts_line_item_idx`.
  - Grants: SELECT, INSERT and DELETE only.

*Backend*
- [x] `src/server/storage/{receipt-storage.ts, s3-receipt-storage.ts, memory-receipt-storage.ts, fs-receipt-storage.ts, sniff.ts}`.
- [x] `receipts.service.ts` `upload(ctx, claimId, lineItemId, file)` + `receipts.repo.ts`, upload in this order:
  1. Check `Content-Length` and the 10 MiB limit (413).
  2. Check the type allowlist and the magic bytes (422).
  3. Compute sha256.
  4. Pre-check: visible owner claim, line belongs to the claim, claim editable, fewer than 5 receipts on the line.
  5. `storage.put()`, outside any transaction.
  6. `withTx`: lock, re-check, insert the row.
  7. If the transaction fails, best-effort `storage.delete()`.
- [x] Downloads stream with `Content-Disposition: attachment`, `nosniff` and `no-store`, and include receipts referenced only by an older snapshot.
- [x] Deletes follow retention rule D-31.
- [x] Add the C-25 receipt-key steps to `claims.service` `replaceClaim` and `deleteDraft`: collect `receipts.storage_key` for the removed lines (or the whole claim) inside the tx; after commit, if `current_revision = 0`, call `storage.delete()` on each and log `receipt.object_orphaned` on failure.
- [x] Routes (append their keys to `EXPECTED_ROUTES`):
  - `POST /api/v1/claims/:claimId/line-items/:lineItemId/receipts`.
  - `GET /api/v1/claims/:claimId/receipts/:receiptId/content`.
  - `DELETE /api/v1/claims/:claimId/receipts/:receiptId`.
- [x] Snapshot `lines[].receipts[]` carries `storageKey` and `sha256`. `/api/health/ready` reports `storage: ok | degraded`.

*Frontend*
- [x] Attach, view and remove on each saved line, hidden unless `EDIT` is allowed. No further polish: cut item 4 is applied up front.
- [x] Specific messages for 413 `PAYLOAD_TOO_LARGE`, 422 `RECEIPT_TYPE_NOT_ALLOWED`, 422 `RECEIPT_LIMIT_REACHED` and the 409s.

*Tests*
- [x] `factories.ts`: add `fakePdf`/`pdfForm` and the receipt option in `makeDraft`. `resetDb()` adds the storage reset (`getStorage`, imported lazily).
- [x] TC-I27 (whole file).
- [x] TC-I11 › "every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED": the receipt upload and receipt delete cases.
- [x] TC-I14 › "uploading a receipt to another claim's line returns 404", "downloading or deleting another claim's receipt through my claim id returns 404 RECEIPT_NOT_FOUND".
- [x] TC-I22 › "receipts referenced by revision 1 stay downloadable after the line is deleted".
- [x] TC-I17 › "history and receipt routes for that claim return 404" (now complete: add the three receipt routes to the imports and `attempts()`, and the `receipts` column to the snapshot query).
- [x] TC-I07 and TC-I08 rows for `receipts`.

**Deliverables.** Per-line receipts through `ReceiptStorage`, with SeaweedFS (or the FS adapter) in compose.

**Exit criteria.**
- The listed tests are green.
- A 9.9 MiB PDF uploads through the compose stack.
- An approved claim shows no attach controls, and the API returns 409 `CLAIM_LOCKED`.
- A submit of a claim with a receipt succeeds (proves #6 v2).

**Walkthrough evidence.**
- Upload to a DRAFT line, then try the same on C04 → 409.
- psql `DELETE FROM receipts` on C04 → UC001.
- Explain why signed URLs are a §8 step behind the same interface.

**Risks & fallback.**
- SeaweedFS misbehaves: switch to the FS adapter, using the full fallback recipe above.
- Multipart edge cases: pre-check `Content-Length` before `request.formData()`.
- Slip: the D7 PM half moves to D10 AM with the rest (see **Why now**).

**Links.** [06 receipts storage](docs/design/06-cross-cutting.md) · [04 receipt routes](docs/design/04-security-and-api.md) · [03 receipts trigger](docs/design/03-data-model-and-integrity.md)

---

### P7: Finance list + streamed export + EXPLAIN (D8, Thu 22)

**Status: Done (2026-10-15).** `pnpm verify` exits 0 (unit 50, component 5, integration 245, no todos). TC-U06, TC-U09, TC-I26, TC-I28 (all 16 cases) and the TC-I03 export case are green. On the compose stack, finance's September export contains C09 (approved 23:59:30 IST on 30 Sep) and not C10; October contains C10. The file has a UTF-8 BOM, CRLF line ends, 24 columns and plain decimal amounts. Open check closed: when the stream breaks mid-download (injected DB error or `docker compose kill app`), curl exits 18 rather than ending cleanly. `pnpm perf:seed` builds `expense_perf` with 10,000 claims in about 25 s with every trigger on and zero drift. `pnpm perf:explain` writes `docs/perf/*.txt`: every export batch is `Limit → Index Scan using claims_export_idx`, with no Sort below the Limit (before: Sort → Seq Scan).
Notes: the finance list is hand-written SQL so it can use its indexes (index scan, no Sort). `dateField=approvedAt` lists only APPROVED claims. One tiny top-1 Sort remains inside the per-claim final-approver lookup (about 1.3 rows). `.claude/` (the desktop app's preview config) is in `.prettierignore`.

**Goal.**
- Finance gets a read-only view across all employees.
- A CSV export of approved claims for a period that never loads everything into memory.
- Query-plan evidence for §6 and §8.

**Why now.** It needs approved claims (P4/P5) and the boundary seed claims C09 and C10.

**Tasks**

*Backend*
- [x] `finance.service.ts`: the first line of every function is `requireRole(ctx.actor, 'FINANCE')`. `financeClaimsWhere(actor)` throws `FORBIDDEN` unless the actor is FINANCE.
- [x] `GET /api/v1/finance/claims` (`FinanceClaimsQuery`; append its key, and the export route's below, to `EXPECTED_ROUTES`, which then holds all 29):
  - `dateField` is `submittedAt` or `approvedAt`.
  - The default status is `SUBMITTED,APPROVED,REJECTED`; DRAFT only when asked for.
- [x] `export.service.ts` (`requireRole`), `export.repo.ts`, and `src/server/export/{csv.ts (csvText), export-stream.ts}`:
  - `asOf = clock_timestamp()` at request start.
  - The period via `businessDayRangeToUtc`.
  - A pull-based `ReadableStream`: each `pull()` runs one `EXPORT_BATCH_SIZE` keyset batch on `(approved_at, id)`.
  - Rows come from the approved snapshot, joined to the final approver.
  - On error, `controller.error()`.
- [x] `GET /api/v1/finance/exports/approved-claims`:
  - Headers `Content-Disposition`, `X-Export-As-Of` and `X-Export-Period-Open`.
  - `Sec-Fetch-Site: cross-site` → 403 `CSRF_REJECTED`.
  - Logs `export.started`, `export.completed` and `export.failed`.

*Frontend*
- [x] `/finance/claims`: the reused `PagedTable` as a plain table (cut item 3 is applied up front), with a claimant column and status/`dateField` filters.
- [x] `/finance/claims/[id]`: the reused `ClaimDetailView` with `allowedActions: []`.
- [x] `/finance/export`: two native date inputs, and an `<a download>` that is enabled once `ExportQuery` validates.

*Perf (core-light; D8's last item: if it isn't done by 16:00, finish it on D10 after P6)*
- [x] `scripts/perf/seed-perf.ts` → `pnpm perf:seed` (under `tsx --conditions=react-server`). [07 §12.1](docs/design/07-testing.md) is the one generator spec (03 §13 links to it):
  - Database `expense_perf`, reached through `PERF_DATABASE_URL=postgresql://expense_owner:local-owner-pw-change-me@localhost:5432/expense_perf`. It is a core variable (C-11): move it out of the commented OPTIONAL block in `.env.example` into the core section.
  - Runs as owner with all triggers on.
  - Default `--claims 10000`; 50k/100k stays in O3.
  - Then `ANALYZE` and a drift check.
- [x] `scripts/perf/explain.ts` → `pnpm perf:explain` (same flag) → `docs/perf/explain-export-before.txt`, `explain-export-after.txt`, `explain-queue.txt` and `explain-finance-list.txt`. For "before", the index is dropped inside `BEGIN … ROLLBACK`. The queue plan uses a PENDING page with `from`/`to` = the last 30 IST days (an `activated_at` range) and LIMIT 26, so it shows the range in the Index Cond.

*Tests*
- [x] TC-I28's IST boundary cases reuse `ownerDecideAt` (added in P4 for TC-I25).
- [x] TC-U06, TC-U09, TC-I26, TC-I28 (whole files).
- [x] TC-I03 › "export GET with Sec-Fetch-Site: cross-site returns 403 CSRF_REJECTED".

**Deliverables.** The finance list and detail, the streamed export, the export page and the EXPLAIN evidence.

**Exit criteria.**
- The listed tests are green.
- The EXPLAIN files show an Index Scan on `claims_export_idx` with no Sort.
- TC-U06 and TC-I28 assert the UTF-8 BOM, CRLF line ends, `amount` and `claim_total` matching `^\d+\.\d{2}$`, and escaped formula cells starting with `'`. Opening the file once in a spreadsheet app is walkthrough evidence, not an exit criterion.

**Walkthrough evidence.**
- Export September and then October: C09 (23:59:30 IST, 30 Sep) lands in September and C10 (00:15 IST, 1 Oct) in October.
- Open the September CSV once in a spreadsheet app: the amounts are plain decimals and the formula payloads are neutralised.
- The EXPLAIN before/after files.
- Stopping the app mid-download produces a failed download, never a silently truncated file.

**Risks & fallback.**
- Open check (from [06](docs/design/06-cross-cutting.md)): on the real image, confirm that Next 16.4 *aborts* the HTTP response when the stream errors. `curl` should exit with code 18 (partial transfer) instead of ending cleanly. TC-I28 only proves that the stream itself errors.
- Streaming quirks in route handlers: lower the range cap to 31 days and emit one chunk per batch.
- The perf seed is slow: it already defaults to 10k claims with triggers on; if it isn't done by 16:00 on D8, finish it on D10 after P6.

**Links.** [06 export, CSV](docs/design/06-cross-cutting.md) · [04 finance routes](docs/design/04-security-and-api.md) · [07 load test, EXPLAIN](docs/design/07-testing.md)

---

### P8: Evidence + hardening (D9, Fri 23)

**Status: Done (2026-10-16), except the CI workflow, which is written but not run (needs a GitHub remote).** Verified: `pnpm verify` exits 0 (unit 50, component 5, integration 245 in 29 files, no todos). `docker compose down -v && up --build --wait` is healthy; the migrate log reads migrate → bucket `receipts` created → seed → `receipt.uploaded` (C04) → C01–C12. `pnpm test:e2e` 7/7 on that fresh stack (TC-E00 to TC-E06; HTML report in `playwright-report/`). `docker compose exec app env` holds only the runtime role: no `MIGRATE_DATABASE_URL`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `POSTGRES_*`, `SEED_DEMO_PASSWORD` or `expense_owner`; uid 1000. All 50 test names quoted in the README §6 table are `it`/`test` titles in the cited TC files, none skipped, and pass in the verify and e2e runs. Clean-clone rehearsal (main stack stopped, volumes kept; 355 files copied, so no `node_modules`, `.env`, `.next` or `src/generated`): prerequisites (Compose v5.6.0, 7.7 GiB Docker VM, ports 3000/5432/8333 free) → `cp .env.example .env` → `docker compose -p ec-rehearsal build --no-cache` and `up --build --wait`, healthy; API login as all nine demo accounts with the roles the README lists; pages with curl (200 with a session, 307 to `/login?next=…` without); Farah's September CSV (C04, C09); in the copy `pnpm install` → `pnpm test:e2e` 7/7, `pnpm verify` green, both demo scripts exit 0 (five SQL refusals incl. the C04 receipt DELETE → UC001), `verify:integrity` 0 rows; then `down -v` and the copy deleted. README fixes from it: the Compose version (v2.21 or newer, v5 included), `pnpm db:generate` before the host scripts, the login page does NOT list the demo accounts (README, demo script and `.env.example` said it did; `DEMO_MODE` is only validated), a port override also needs `E2E_BASE_URL` and the host URLs, the pinned project name `expense-claims` (two checkouts share one stack; use `-p`), first-run time, and that e2e adds demo data. Graceful shutdown: an idle `docker compose stop app` takes 0.3 s and exits 143 with `app.shutdown` logged (the listener 06 §3.4 describes was missing; added to `src/instrumentation.ts`, logging only). During a 366-day export (4,426 claims, 17,822 rows; app pointed at `expense_perf`, curl at 100 KB/s) the stop took 20.4 s (SIGKILL at the grace period, exit 137) and curl exited 18 with a partial file; a small export already buffered at SIGTERM still completes byte-identical. `pnpm verify:integrity` prints 0 rows; `pnpm build` works with no `.env` (restored, sha256 unchanged). `pnpm perf:seed` (same flags) + `pnpm perf:explain` re-run: the export plans now show the final-approver LATERAL as `Limit → Index Scan Backward using approval_steps_submission_id_level_key` (no Sort). The first September batch now plans as a bitmap scan of `claims_export_idx` + a Sort of 419 ≤ 500 rows (the reloaded heap's physical order flipped the planner's choice); `perf:explain` accepts that shape only with that bound, and 06 §7 / 07 §12.2 / the demo script say so. Stale migrate → seed → ensure-bucket references fixed in `compose.yaml`, 00, 01, 03, 00-traceability and this plan.

**Goal.** A reviewer can clone, run, read and verify everything.

**Why now.** All behaviour exists. What's left is proving it end to end on the real image and writing the evidence the learning path requires.

**Tasks**

*Carried over from P7*
- [x] `GET /api/v1/claims` (`listMine`) uses Prisma's `_count` for the line-item count, and Prisma counts over the whole `line_items` table on every page. Replace it with a per-page count (a LATERAL/grouped count over just the page's claim ids, as the finance list does), then re-check with EXPLAIN.
- [x] Docs: 07 §12.2 `capture()` comment (ROLLBACK does not DEALLOCATE a prepared statement); the C-12 script contract (`perf:explain` runs its 'after' plans as `expense_app` on `expense_perf`); 06 §7 / 07 §12.2 expected finance/queue 'before' plans (they are bitmap/partial-index scans plus a Sort, not Seq Scans).
- [x] Optional: rewrite the export's final-approver LATERAL as a backward scan of `approval_steps_submission_id_level_key` to drop its tiny top-1 Sort.

*Carried over from P6*
- [x] Seed one receipt on C04's first line before it is approved. Reorder the tools `release` to migrate → ensure-bucket → seed, so the bucket exists when the seed runs. Then the §7 Q2 demo `DELETE FROM receipts` on C04 as `expense_app` shows UC001; today C04 has no receipt, so that statement matches 0 rows.

*Tests (E2E)*
- [x] `playwright.config.ts`: `E2E_BASE_URL`, `workers: 1`, `timezoneId: 'America/Los_Angeles'`, and a storageState per persona.
- [x] CORE:
  - TC-E00 `auth.setup.ts`.
  - TC-E01 "asha submits ₹25,000, ravi then meera approve, farah exports it". It attaches no receipt, so it doesn't depend on P6 (the attach step lives in TC-E05, [05 §15.3](docs/design/05-frontend.md)).
  - TC-E02 "neha opening asha's claim sees the not-found view and the API returns 404".
  - TC-E04 `page-redirects.spec.ts` "every (app) page redirects to /login without a session". It is the only test of the page half of §6-3, so it is never cut.
  - TC-E06 "a clean docker compose up is healthy and the app container holds no owner or superuser credentials". Its service and port lists include `objectstore` only when `RECEIPT_STORAGE_DRIVER` isn't `fs`.
- [x] CORE-if-on-time: TC-E03 and TC-E05 (TC-E05 attaches `e2e/fixtures/receipt.pdf` to line 1, so it needs P6).

*Docs-DevOps*
- [ ] `.github/workflows/ci.yml` (moved from P1): frozen install → `prisma generate` → typecheck → lint → format check → unit → component → integration (Testcontainers) → drift (`pnpm db:deploy && pnpm db:diff-check` against the compose postgres, no shadow DB). A draft from P0 already exists in the repo; align its drift step with this rule. **Written, not run (needs a GitHub remote):** the YAML parses, every action tag exists, and its drift step passes locally against the compose postgres (`No pending migrations`, `No difference detected`).
- [x] `README.md` covering:
  - Problem solved; run instructions (`cp .env.example .env && docker compose up --build --wait`); demo accounts.
  - Prerequisites: Docker Desktop/Engine with Compose v2 (supports `up --wait`), ≥ 6 GB RAM for the Docker VM, and host ports 3000, 5432 and 8333 free on 127.0.0.1 (otherwise set `APP_PORT` / `POSTGRES_HOST_PORT` / `S3_HOST_PORT` in `.env`). Nothing else is installed on the host.
  - Application flow and an architecture diagram.
  - Data model (link to the ERD) and the API route table.
  - Authentication and authorization approach.
  - **The §6 table** (bullet → enforcement point → exact test name). The §6-6 row says that the export `status` parameter accepts only `APPROVED` (422 otherwise), which is how the export meets the status-filter check.
  - The "document it" decisions (receipts, thresholds, amount-change rule, store vs calculate).
  - The interpretation decisions:
    - Export period = the final `approved_at`, inclusive IST dates `[from 00:00, to+1 00:00)`.
    - Export `status` accepts only `APPROVED` (422 otherwise), which is how the export meets the §6 status-filter check.
    - Decided approvers keep read-only access.
    - Finance reads every claim, including drafts, and edits only its own.
    - The reject reason is required (10–1000 characters); the approve comment is optional.
    - `PUBLIC_ROUTES` = login + `/api/health/live` + `/api/health/ready`; everything else returns 401.
  - The Azure mapping, and known limitations / next steps.
- [x] Eight one-page ADRs in `docs/adr/`:
  - 0001 single Next app & REST-only (with the P0 fallbacks used).
  - 0002 layering & import boundaries.
  - 0003 claim-total integrity (with the spike results).
  - 0004 lifecycle, revisions & the amount-change rule (with receipts per line).
  - 0005 data-driven routing.
  - 0006 authz, 404-vs-403 & scoped queries.
  - 0007 sessions vs JWT & the Entra mapping.
  - 0008 DB roles & migrations as a job.
- [x] `docs/walkthrough.md`: the [§7](#7-walkthrough-prep) answers with real file and line pointers.
- [x] `docs/demo-script.md`: click path and commands.
- [x] `docs/runbook.md`:
  - The query for stuck PENDING steps whose approver is no longer eligible.
  - Orphaned objects.
  - Scheduling `pnpm verify:integrity` as a production job.
- [x] Clean-clone rehearsal: check the README prerequisites (Compose v2 with `--wait`, ≥ 6 GB for the Docker VM, ports 3000/5432/8333 free) → `git clone` into a temp directory → `cp .env.example .env` → `docker compose up --build --wait` → follow the README word for word. Done without `git clone` (commits are on hold): the files `git ls-files -co --exclude-standard` lists were copied into a temp directory.
- [x] Graceful shutdown: run `docker compose stop app` during an export. The download fails, and the container exits within `stop_grace_period: 20s`.

**Deliverables.** Playwright suite, README, 8 ADRs, walkthrough, demo script, runbook.

**Exit criteria.**
- `pnpm verify` is green.
- `pnpm test:e2e` is green against a fresh `docker compose up --wait`.
- The clean-clone rehearsal succeeds.
- Every §6 row in the README names a test that exists and passes.

**Gate (D9 noon).** If e2e is red, drop TC-E03 and keep E01, E02, E04 and E06.

**Walkthrough evidence.**
- The README.
- The Playwright HTML report.
- `docker compose exec app env`, showing no owner or superuser variables.

**Risks & fallback.**
- Shared seeded queues make e2e order-dependent: run with `workers: 1` and unique claim titles.
- Export assertions near IST midnight: use a yesterday-to-today window.

**Links.** [07 E2E](docs/design/07-testing.md) · [01 compose, CI](docs/design/01-architecture-and-stack.md)

---

### BUF: Buffer (D10 PM, Mon 26)

D10 AM belongs to P6's second half. Use the afternoon in this order:
1. **Slipped core work**: whatever P6 left, then any perf seed + EXPLAIN work not finished on D8. If P6 landed today, re-run e2e and the clean-clone rehearsal.
2. **Demo rehearsal**: run `docs/demo-script.md` timed, twice, from a fresh `docker compose down -v && up`.
3. **Optional phases** O1 → O2 → O3 → O4, below. Stop at 16:00 and re-run `pnpm verify`, e2e and the clean-clone rehearsal.

### Optional phases (after core; §8 depth)

| Phase | Item | Effort | What gets built | Tests |
|---|---|---|---|---|
| **O1** | Reproducible export (OPTIONAL, the first SHOULD) | 1–2 h | Migration `…_export_runs`, which adds enum `export_run_status`, table `export_runs` (RUNNING → SUCCEEDED/FAILED with counts, total and sha256) and a trigger making terminal rows immutable. One REPEATABLE READ READ ONLY transaction for all batches. An `EXPORT_MAX_CONCURRENT` semaphore (429). Optional `GET /api/v1/finance/exports/approved-claims/summary` and `GET /api/v1/finance/exports` | TC-O04 |
| **O2** | §8-2 signed upload URLs | ~1 day | Migration `…_receipt_upload_intents` (`receipt_status` PENDING/UPLOADED). `POST …/line-items/:lineItemId/receipts/upload-intent` returns a presigned POST to `pending/{receiptId}` with `content-length-range`, an exact Content-Type and a TTL ≤ 120 s. `POST …/receipts/:receiptId/confirm` takes the lock and checks status, then HEAD + magic bytes + sha256, then CopyObject to the final key. Plus an `S3_PUBLIC_ENDPOINT` signer, bucket CORS, a sweeper, a 60 s presigned GET and a scoped non-admin S3 identity | TC-O01 |
| **O3** | §8-3 load test at two years | ½ day | `pnpm perf:seed --claims 100000`; k6 2.3 `load/export.k6.js` under compose profile `load`, with p95 thresholds and RSS measurement; plan assertions | TC-O02, TC-O03 |
| **O4** | Observability | ½ day | OpenTelemetry via `@vercel/otel` and `@prisma/instrumentation`, plus a Jaeger compose profile | — |
| **O5** | Other stretch | as time allows | Login rate limiting (429 `RATE_LIMITED`); claim `version` optimistic concurrency; reassign endpoint (`STEP_REASSIGNED`); nonce CSP; e2e in CI; Dependabot and SHA-pinned actions; fast-check | TC-O05, TC-E07 |

§8 bullet 1 (a variable-length chain) is already delivered in core, in P3, via the inactive `L4_CFO` row.

---

## 5. Day-by-day timeline and critical path

| Day | Date | AM | PM | End-of-day check |
|---|---|---|---|---|
| D1 | Tue 13 Oct | P0: start Docker, toolchain, scaffold, Prisma 7, `01-roles.sh`, migrations `init` + `integrity_core` + `privileges`, drift check | P0: Testcontainers harness, TC-I00 (a) to (e), Dockerfile + compose + health | Spike green; image builds. **Done** |
| D2 | Wed 14 Oct | P0: clean compose boot, TC-I06/I07/I08, Day-1 checks, P0 exit. **Done** (only the `db:reset` check waits for the user's consent) | P1: Next security patch, env + boot checks, pino + ALS, `defineRoute`, errors, health rewrap; sessions + login/logout/me; seed personas/categories | **End of D2: Plan B gate** (already passed: TC-I00 green in P0). TC-I01, TC-I02 green |
| D3 | Thu 15 Oct | P1: CSRF, login page + shell + proxy + api-client, scaffold page cleanup; TC-I03 to TC-I05 | P2: shared money/dates/schemas, visibility predicate + `findClaimForActor`, claims repo + service, PUT replace-set, delete, routes; TC-I09, TC-I10, **TC-I12** | P1 exit; desync suite green |
| D4 | Fri 16 Oct | P2: `ClaimForm` only; **TC-I13**, TC-I14, **TC-I17 (P2 form)**, TC-I24 | P3: migration `workflow`, tiers in `seedReference()`, boot step 4, `buildChain` + TC-U03 | **Gate: TC-I12, TC-I13 and the TC-I17 owner-scoped form green** |
| D5 | Mon 19 Oct | P3: submit service, `recordEvent`, `SeedClock`, stepper UI; TC-I15, TC-I16, TC-I23 (submit) | P4: visibility EXISTS clause, `lockClaimRoutedToMe`, approve/reject; **TC-I17 approve/reject cases** | TC-I17 approve/reject cases green |
| D6 | Tue 20 Oct | P4: `/approvals` endpoint, shared `PagedTable` for `/claims` + `/approvals` (with From/To), review page | P4: TC-I18 (F1), TC-I19, TC-I20 (parallel approvals), TC-I25, TC-C01; seed C04/C05/C08/C11/C12 | **Gate: TC-I17 (minus history/recall/receipt rows) + TC-I18 (F1) green**; if > ½ day behind, cut item 2 |
| D7 | Wed 21 Oct | P5: recall, resubmit, history route, `lastRejection`, banners, raw event list; TC-I11, TC-I21, TC-I22, TC-I18 recall/history + F2, TC-I20 race; demo scripts | **Noon: storage gate + probe.** P6 first half: objectstore + ensure-bucket, receipts migration (#10 + #6 v2), storage adapters, routes | P5 done; P6 first half done or moved to D10 AM |
| D8 | Thu 22 Oct | P7: finance list + detail, export stream + route | P7: export page, TC-I26, TC-I28; last item: perf seed (10k) + EXPLAIN files | EXPLAIN shows Index Scan with no Sort (perf work not done by 16:00 moves to D10 after P6) |
| D9 | Fri 23 Oct | P8: Playwright E00/E01/E02/E04/E06 (+E03; E05 once P6 lands) | P8: README §6 table + prerequisites + interpretation decisions, 8 ADRs, walkthrough/demo/runbook, CI workflow, clean-clone rehearsal, shutdown check | **Noon: e2e gate.** `pnpm verify` + core e2e green |
| D10 | Mon 26 Oct | P6 second half: receipt-key steps, receipts UI, TC-I27 + receipt cases of TC-I11/I14/I17/I22, TC-E05 | BUF: slips, re-run e2e + clean clone, demo rehearsal ×2, then O1 → O2 → O3 → O4 | Final verify + e2e + clean clone |

### Critical path

```mermaid
flowchart LR
  P0["P0 · D1 to D2 AM<br/>skeleton + integrity spike (done)"] --> P1["P1 · D2 PM to D3 AM<br/>identity + request spine"]
  P1 --> P2["P2 · D3 PM to D4 AM<br/>drafts + total integrity"]
  P2 --> P3["P3 · D4 PM to D5 AM<br/>submit, routing, audit"]
  P3 --> P4["P4 · D5 PM to D6<br/>queue + decisions"]
  P4 --> P5["P5 · D7 AM<br/>reject, recall, lock proof"]
  P5 --> P7["P7 · D8<br/>finance + export"]
  P7 --> P8["P8 · D9<br/>evidence + hardening"]
  P8 --> BUF["BUF · D10 PM<br/>slips, rehearsal, optional"]
  P5 -.-> P6["P6 · D7 PM + D10 AM<br/>receipts"]
  P6 -.-> BUF
```

The critical path is P0 → P1 → P2 → P3 → P4 → P5 → P7 → P8, which is 8.5 days. P6 is planned as D7 PM + D10 AM. It can move entirely to D10 AM: if it does, TC-I27, the receipt parts of TC-I11/I14/I17/I22, TC-E05 and the objectstore compose change land on D10, followed by the BUF re-run of e2e and the clean-clone rehearsal.

### Decision gates

| When | Gate | If it fails |
|---|---|---|
| End of P0 (D2 AM). **Met** | TC-I00 (a) to (e) green; standalone image healthy | Image: hoisted → `--webpack` → non-standalone. Spike: fix by the end of D2, otherwise the next gate |
| **End of D2.** **Met** (TC-I00 green in P0) | Total spike green | Switch to Plan B compute-on-read (D-13) and adapt the TC-I12 wording |
| End of D4 | TC-I12, TC-I13 and the TC-I17 owner-scoped first form green | Stop feature work until they are green. They are the POC's centre of gravity |
| End of D6 | TC-I17 (except the history, recall and receipt rows) + TC-I18 (fixture F1) green | If more than ½ day behind, apply cut item 2 now (items 3–5 are already applied) |
| D7 noon | The object-store probe passes and SeaweedFS works from the app | Use the full FS fallback in P6 (`RECEIPT_STORAGE_DRIVER=fs`, receipts volume, objectstore removed) |
| D9 noon | E2E green | Drop TC-E03 and keep E01, E02, E04 and E06 |

### What to cut first if behind (in this order)

1. All §8 and OPTIONAL items (O1 to O5).
2. Playwright reject → resubmit (TC-E03).
3. Finance list UI polish; keep the API and a plain table. **Applied up front.**
4. Receipts UI polish; keep upload, list and view. **Applied up front.**
5. The timeline UI; render the raw event list instead. **Applied up front.**
6. The CI workflow (now a P8 task); run `pnpm verify` locally.

**Never cut** (any §6 item):
- The validation tests and the specific failure codes.
- The route-auth inventory, and TC-E04 (the page half of §6-3).
- The sharpest test and the desync test.
- Keyset and streamed filtering.
- Audit events.
- `docker compose up` with only `.env`.

---

## 6. Definition of Done and submission evidence

### 6.1 POC Definition of Done (learning path)

- [ ] The POC is functionally complete: every §3 requirement works through the UI and the API.
- [ ] It demonstrates the core full-stack capabilities (see the [learning map](#10-learning-path-checkpoint-map)).
- [ ] All implementation evidence below is provided.
- [ ] I can explain the implementation without notes ([§7](#7-walkthrough-prep)).
- [ ] The RM has reviewed and approved the POC against the evaluation criteria.

### 6.2 Evidence checklist

| Evidence (learning path) | What we hand over | Check |
|---|---|---|
| **Source code**: repository link, readable structure | Git repo with the C-18 folder layout; committed lockfile; no secrets (`.env` gitignored, `.env.example` complete); CI green on `main` | - [ ] `pnpm verify` green · - [ ] CI green · - [ ] `pnpm db:deploy && pnpm db:diff-check` clean |
| **Working application**: frontend, server, database, key flows | `docker compose down -v && cp .env.example .env && docker compose up --build --wait` from a clean clone. Flows demoable with the seed cast: submit → L1 → L2 → export; reject → edit → resubmit; recall; locked claim; foreign claim 404; finance read-only; L4 activation | - [ ] clean-clone rehearsal · - [ ] TC-E01, TC-E02, TC-E04, TC-E06 green · - [ ] demo script run twice |
| **Technical summary**: problem, flow, data model, APIs, authn/authz, decisions, run instructions | `README.md`, with the prerequisites, the §6 table (bullet → enforcement point → test name), the "document it" and interpretation decisions, the route table, the Azure mapping and next steps | - [ ] every README test name exists · - [ ] a teammate can run it from the README alone |
| **Technical walkthrough**: request flow, logic, DB operations, validation, authz, errors, testing | 8 ADRs; `docs/walkthrough.md`; `docs/demo-script.md`; `scripts/demo/edit-approved.sh` and `sql-attacks.sh`; `docs/perf/*.txt`; `docs/runbook.md`; this PLAN and `docs/design/*` | - [ ] §7 Q1–Q3 rehearsed live · - [ ] 15+ extra questions rehearsed |

### 6.3 Demo storyline (about 12 minutes; the full script lives in `docs/demo-script.md`)

1. `docker compose up --wait` from clean, then `docker compose ps`.
2. Asha creates a 3-line claim and saves it. The "calculated by the database" total updates.
3. Asha submits a ₹25,000 claim. The stepper shows Ravi then Meera, and `claim_events` gets a row with its `request_id`.
4. Neha opens Asha's claim URL and sees the not-found view. Run TC-I17 live.
5. Ravi approves; Meera approves; the claim locks. Show `edit-approved.sh` (409) and `sql-attacks.sh` (UC001, UC003, 42501).
6. Asha opens C05 (seeded REJECTED by Ravi: "Hotel invoice missing for 3 Oct"); the banner shows the reason, the approver and the IST time. She edits and resubmits. Show the history with both revisions (§7 Q3). If a live rejection is wanted, Asha submits a second fresh claim in step 3 (step 3b) and Ravi rejects that one, since C05 has no PENDING step left (Ravi would get 409 `ALREADY_DECIDED`).
7. Farah exports September and October. Open the CSV. Show the EXPLAIN before/after files.
8. Run `pnpm policy:activate-tier L4_CFO`. A ₹2,50,000 claim gets a 4-step chain with no code change.

---

## 7. Walkthrough prep

### 7.1 §7 Q1: How does the approval chain know which approver is next? What if the amount changes mid-chain?

**In one line:** the chain is data. It is computed once at submit and stored as rows, so "next" is simply the next row.

1. `POST /api/v1/claims/:claimId/submit` → `src/server/services/lifecycle.service.ts#submit` locks the claim and loads two things:
   - The active tiers, via `tiers.repo.ts`.
   - The reporting lines, via `src/server/routing/org-loader.ts`, a recursive CTE.

   It then calls the pure `buildChain({ tiers, claimant, org, totalMinor })` in `src/server/routing/build-chain.ts`.
2. `buildChain` keeps every active tier whose `applies_above_minor` is below the total. The thresholds are exclusive: > ₹0, > ₹10,000, > ₹50,000, and L4 > ₹2,00,000 (inactive). Tiers are ordered by `level`, and each is resolved through its resolver:
   - The primary: the `levels_up`-th manager, or the designated user.
   - If the primary is ineligible (claimant, FINANCE, inactive, no `can_approve`, or already in the chain), escalate upward.
   - Then the fallback approver.
   - If nobody is eligible → 422 `ROUTING_UNRESOLVABLE`, and nothing is written.
3. The chain is inserted as `approval_steps` rows on the new `claim_submissions` revision: level 1 PENDING, the rest WAITING. Each step keeps a copy of its tier code, label and threshold, so later org-chart or policy edits don't touch in-flight claims.
4. Approving level n (`approvals.service.ts`) flips level n+1 from WAITING to PENDING in the same transaction. The final approval sets the claim APPROVED. An approver's queue is simply `approver_id = me AND status = 'PENDING'` on a partial index.
5. The DB backs this up:
   - `claims_guard` refuses → SUBMITTED unless the step count equals the number of applicable active tiers (UC012).
   - `approval_steps_guard` refuses WAITING → PENDING out of order, and re-checks eligibility at decision time (UC008).

**Amount changes mid-chain:** an amount can't change in place. While the claim is SUBMITTED, `PUT` returns 409 `CLAIM_NOT_EDITABLE` with `hint: RECALL_TO_EDIT`, and the line trigger raises UC002. Instead, the claimant **recalls**, which is allowed until the final approval:
- Open steps become CANCELLED and are kept.
- Already-APPROVED steps stay in history on that revision.
- The claim returns to DRAFT.

The next submit builds a **brand-new chain from the new total**, and earlier approvals never carry over. An approver holding a stale tab is stopped by the `revision` in the approve body (409 `REVISION_MISMATCH`). The reason for this design: approvals bind to the content the approver saw, not to an amount bucket, and there is only one chain builder to test.

**Show:** TC-U03 (₹10,000.00 → 1 step; ₹10,000.01 → 2); TC-I16 › "only level 1 is PENDING at submit; approving level n activates n+1"; TC-I21 › "resubmitting at a higher amount builds a fresh chain from the new total (1 → 3 steps)"; live, `pnpm policy:activate-tier L4_CFO` → 4 steps.

### 7.2 §7 Q2: An approved claim is read-only. Where is that enforced: the UI, the service or the database?

**All three, and the database is the guarantee.**

| Layer | Where (to be built) | What happens |
|---|---|---|
| UI | `ClaimDetailView` renders actions only from `allowedActions`, which `decide()` in `src/server/authz/claim-policy.ts` computes | No edit, attach or submit buttons. This is cosmetic by design |
| Service | `claims.service.ts`, `lifecycle.service.ts`, `receipts.service.ts`: `lockOwnedClaim()` (`FOR NO KEY UPDATE`), then a status check | 409 `CLAIM_LOCKED` with `details.status = 'APPROVED'` |
| Database | `claims_guard` raises UC001 on any UPDATE or DELETE of an APPROVED claim. `line_items_before_write` and `receipts_before_write` call `assert_claim_editable()`, which locks the parent claim and raises UC001 | Raw SQL, a Prisma call or a future bug are all refused. `readSqlState()` → `map-error.ts` returns the same 409 `CLAIM_LOCKED` |
| Privileges | `expense_app` can't `DISABLE TRIGGER`, `TRUNCATE` or `SET session_replication_role` (42501). Owner credentials never reach the app container. `/api/health/ready` returns 503 if any integrity trigger is disabled | The guarantee can't be switched off from the app |

Why the DB: it is the only layer that every path crosses, including ones we haven't written yet.

**Show:** the UI first, then `scripts/demo/edit-approved.sh`, then `scripts/demo/sql-attacks.sh`. Tests: TC-I11 (API, Prisma and raw SQL), TC-I07 › "expense_app cannot DISABLE TRIGGER, TRUNCATE, or SET session_replication_role (42501)", TC-I27, TC-E05.

### 7.3 §7 Q3: Show me a rejected claim returning for edit. What is preserved and what is reset?

Demo on **C05**: Asha's ₹12,000 claim, rejected by Ravi with "Hotel invoice missing for 3 Oct". Asha edits it (it stays REJECTED, so the banner remains), then resubmits.

| Preserved | Reset |
|---|---|
| Claim id, `claim_number`, claimant, `created_at` | Status: REJECTED → SUBMITTED on resubmit; `rejected_at` cleared |
| The revision-1 `claim_submissions` row and its snapshot (INSERT-only, DB-verified) | `current_revision` increments, with a new snapshot of the edited lines |
| Every revision-1 step, with its decision, reason, comment and timestamps (decided steps are immutable, UC006) | A **brand-new chain** built from the new total (C06 shows 2 steps → 1 step); prior approvals never carry over |
| Every event: `CLAIM_SUBMITTED` (r1) → `CLAIM_REJECTED` (r1) → `CLAIM_RESUBMITTED` (r2), append-only | Editability: the claim is frozen again while SUBMITTED |
| Receipt objects referenced by the revision-1 snapshot, even if the line is deleted (D-31) | — |
| Ids of kept lines (the editor sends `lineItemId`, so edits are updates, not delete + insert) | — |

Code: the same `lifecycle.service.ts#submit` handles first submit and resubmit, and `GET /api/v1/claims/:claimId/history` returns both revisions with their outcomes. **Show:** TC-I22 › "preserved vs reset: claim number, events, reasons and prior steps preserved; status, chain and editability reset", "events read CLAIM_SUBMITTED(r1) → CLAIM_REJECTED(r1) → CLAIM_RESUBMITTED(r2)".

### 7.4 Further likely questions

**1. Why store the total, if compute-on-read can't drift?**

Routing, the queue, sorting and the export all need the number cheaply, and an approval must sign a frozen number anyway. Postgres is the only writer:
- A statement trigger recomputes `SUM` from scratch, never applying deltas.
- A guard rejects every other write (UC003).
- A deferred check re-asserts the total at COMMIT (UC009).

Compute-on-read survives as the auditor: `v_claim_total_drift` and `pnpm verify:integrity` must always return 0 rows.

**2. Two tabs add a line to the same claim at the same moment. Walk me through it.**

Each insert's row trigger takes `FOR NO KEY UPDATE` on the parent claim, so the second insert waits. When the first commits, the second's recompute runs as a new statement with a fresh snapshot and sums both lines. TC-I13 shows the waiting session in `pg_stat_activity` and a final total of 300.

**3. Why `FOR NO KEY UPDATE` and not `FOR UPDATE`?**

A line insert's foreign-key check takes `FOR KEY SHARE` on the claim. `FOR UPDATE` conflicts with that, so two inserting transactions can deadlock while upgrading their locks. `NO KEY UPDATE` is compatible with KEY SHARE but conflicts with itself, so writers queue instead of deadlocking. It is also the lock an ordinary UPDATE takes.

**4. What stops a future developer from writing `UPDATE claims SET total_minor = …`?**

Four layers:
- Strict schemas return 422 `TOTAL_IS_DERIVED`.
- No service writes the column.
- The DB rejects any write that doesn't come from the recompute trigger (UC003).
- Even a buggy trigger is caught by the deferred check at COMMIT (UC009).

**5. What if someone just disables the trigger?**

The app connects as `expense_app`, which owns nothing. `DISABLE TRIGGER`, `TRUNCATE` and `session_replication_role` all fail with 42501 (TC-I07). Owner credentials exist only in the migrate job. If an owner disables the recompute trigger inside a transaction, the deferred check refuses the COMMIT (TC-I12, the owner-sabotage case). Beyond that, it is a DBA action, which production covers with pgaudit and the ready probe.

**6. Why does a foreign claim return 404, while approving it returns 403?**

Reads follow the rule "if you can't see it, it doesn't exist". The response is byte-identical to the one for a random UUID, so ids can't be probed. Approve and reject are commands against *your queue*, and §6 asks for a specific failure. So anything without a PENDING step for you, including an id that doesn't exist, gets the same 403 `NOT_IN_YOUR_QUEUE`, which is still not an oracle.

**7. Prove the refusal happens at the point of the query.**

`findClaimForActor()` AND-composes `claimVisibilityWhere(actor)` into the single SELECT. TC-I17 checks four things:
- The repository returns `null` for Neha.
- `GET` and the child routes return 404.
- Approve and reject return 403.
- Zero rows changed and zero events were written.

Lint confines Prisma to repositories, and no unscoped `findClaimById` exists.

**8. How does the approver queue avoid loading every claim?**

`approval_steps WHERE approver_id = me AND status = 'PENDING'`, with an optional IST range, uses keyset pagination on `(activated_at, id)` with `LIMIT n+1`. A partial index covers only PENDING steps. EXPLAIN shows an Index Scan with no Sort, and there is no `COUNT(*)`.

**9. Why keyset pagination instead of OFFSET?**

OFFSET reads and throws away every skipped row, and it skips or duplicates rows when new ones arrive. A cursor `(sortValue, id)` is a position: each page costs O(page size) and stays stable under concurrent inserts. `timestamptz(3)` makes the cursor round-trip exactly through a JS `Date`.

**10. How does the export stay memory-bounded, and what if it fails halfway?**

A pull-based `ReadableStream`: each `pull()` fetches one 500-claim keyset batch on `(approved_at, id)` and enqueues its CSV, and the next `pull()` happens only when the client has read it. Memory depends on the batch size, never on the period length. Any error calls `controller.error()`, so the browser reports a failed download instead of saving a truncated file that looks complete.

**11. A claim approved at 00:15 IST on 1 October: which month's export?**

October. The period is inclusive IST calendar dates, converted once to `[from 00:00 IST, (to+1) 00:00 IST)` on `approved_at`. TC-I28 proves that the September and October exports together equal the Sep–Oct export, with no duplicates and no gaps (seed claims C09 and C10).

**12. Why can't an in-flight or rejected claim appear in the export?**

Five reasons:
- The predicate is `status = 'APPROVED'`.
- A CHECK ties `approved_at` to APPROVED, so a partially approved claim has no date to fall into a range.
- APPROVED is terminal, enforced by trigger.
- Rows come from the frozen approved snapshot.
- Only `approved_at < asOf` is included.

`status=REJECTED` on the export → 422 `EXPORT_STATUS_NOT_ALLOWED`.

**13. Why integer paise?**

`0.29 * 100` is `28.999999999999996` in JavaScript. Amounts are integers on the wire, in TypeScript and in Postgres. Input is parsed with string math, and display passes a decimal *string* to `Intl.NumberFormat('en-IN')`.

**14. Six months from now: "who approved this, and why?"**

`GET /claims/:id/history` reads `claim_events` and `claim_submissions`. Each event was written in the same transaction as its state change and carries the actor, from/to status, revision, step, total, reason and `request_id`. They are append-only: SELECT+INSERT grant plus `forbid_mutation`. The `request_id` joins the event to that request's log lines.

**15. Why not use the logs as the audit trail?**

Logs are operational: they are sampled and rotated, and a log line can describe an action that later rolled back. The audit row commits or rolls back together with the change, and the DB refuses a status change without one (UC015).

**16. Why can't finance approve, and where is that enforced?**

In four places:
- The `users_finance_cannot_approve` CHECK.
- `buildChain` skips FINANCE users.
- `approval_steps_guard` re-checks eligibility at insert and at decision time (UC008).
- The route role gate returns 403 `FORBIDDEN` before any query.

**17. An approver leaves, or the org chart changes, mid-chain. What happens?**

The chain was materialised with fixed `approver_id`s at submit ("routed per the org chart as of submit"). A deactivated approver's step can't be decided, because the DB re-checks eligibility. The day-one remedy is recall and resubmit, which re-routes against current data. The runbook has the stuck-steps query, and a reassign endpoint is OPTIONAL.

**18. Can someone approve their own claim?**

No:
- `buildChain` skips the claimant and escalates.
- `approval_steps_guard` rejects `approver_id = claimant_id` (UC008).
- `UNIQUE(submission_id, approver_id)` stops one person signing two tiers.

**19. The claimant recalls or resubmits while I'm reviewing. What happens to my click?**

The content can't change under me while the claim is SUBMITTED. After a recall I have no PENDING step, so I get 403 `NOT_IN_YOUR_QUEUE`. After a resubmit where I'm L1 again, my stale `revision` gets 409 `REVISION_MISMATCH` and the UI reloads. Either way, I never approve content I didn't see.

**20. Sessions or JWT, and how would Entra ID fit in?**

We hit Postgres on every request anyway, so an opaque token lookup costs nothing extra and buys instant revocation and always-current roles. Early JWT revocation needs a denylist, which is another DB lookup. Entra would be an OIDC code + PKCE callback:
1. Validate `iss`, `aud`, `tid` and `nonce`.
2. Map `oid` + `tid` to a user, never the email.
3. Call the same `createSession()`.

Authorization only ever sees an `Actor`, so nothing else changes.

**21. Why isn't authentication in middleware or `proxy.ts`?**

CVE-2025-29927 showed that a single header could skip Next middleware. `defineRoute` authenticates inside every handler, and TC-I01 imports every `route.ts` and asserts 401 with no proxy involved, including "the x-middleware-subrequest header does not bypass authentication". If `proxy.ts` were deleted, the API would be exactly as secure.

**22. Why Route Handlers, and no Server Actions or tRPC?**

One deployable, one set of shared Zod schemas, and one way in that Vitest, curl and Playwright all exercise. Server Actions are implicit public POST endpoints, a second way in. tRPC trades HTTP status codes for RPC semantics. Services don't import `next/*`, so either could be layered on later.

**23. Why two database roles, and how do migrations run?**

Least privilege:
- `expense_owner` owns the schema and runs only in the one-shot `migrate` container (the same image's `tools` target): `migrate deploy` → ensure-bucket → idempotent seed.
- `expense_app` has DML only, owns nothing, and has no TRUNCATE, TEMP or CREATE.

The app waits for `service_completed_successfully`. On Azure this would be a Container Apps Job that runs before the new revision goes live.

**24. Why is the line-item save one PUT of the whole set?**

One request = one transaction = one commit-time total check, so a claim is never half-saved. Every incoming line id must belong to the path claim, which itself must be mine, otherwise 404 `LINE_ITEM_NOT_FOUND` before any write. That closes the IDOR where a foreign line id rides in my body (TC-I14).

**25. How does a trigger exception become a 409 with a specific code?**

Triggers `RAISE … USING ERRCODE = 'UC001'`. `readSqlState()` reads the code from Prisma's P2039/P2010 meta, from a commit-time `DriverAdapterError`, or from pg's error. `map-error.ts` maps **by SQLSTATE only**, never by parsing the message. Pure backstops (UC007 to UC012, UC015, UC016) become a generic 500, logged at `error` with `defense: 'db'`.

**26. Why no Row-Level Security?**

The predicate already makes the database refuse the row. RLS would add a second authorization surface to keep in sync and force every Prisma read into an interactive transaction. It is documented as the next hardening step.

**27. Why receipts per line item, and why upload through the server?**

A receipt proves one expense, and finance reconciles at line (GL) level. A server-proxied upload enforces the size limit before storing anything, checks magic bytes, records sha256 and never hands a client a write credential, so approved evidence can't be overwritten. Presigned URLs are the §8 step behind the same `ReceiptStorage` interface.

**28. Why Prisma 7 and not 8, and TypeScript 6 and not 7?**

Prisma 8 is an RC that lacks transaction isolation levels and P2002-style codes we rely on. TypeScript 7 has no compiler API for type-aware lint yet. Versions are pinned exactly, and an upgrade is an ADR decision.

**29. The HTML page for a foreign claim returns 200. Isn't that a leak?**

No. The page is a client-rendered shell with no data. The security-relevant response is the API's 404, which TC-E02 asserts. Server Components do no data reads at all.

**30. What would you change at 10× the load?**

- Run exports from a read replica or as an async job writing to object storage.
- Partition `claim_events` by month.
- Move uploads to presigned direct-to-store.
- Add OpenTelemetry into App Insights.

The keyset and indexed queries already scale with page size, not table size, and the EXPLAIN files show it.

**31. What did you deliberately not build?**

RLS; Entra code; an admin UI; policy versioning; per-line endpoints; a 90-day age rule; HEIC; and claim `version` (last-write-wins on a claimant's own draft is documented and harmless, because the DB derives the total). Each is a documented next step, per §8: "deepen, don't add".

---

## 8. Risks, assumptions, decisions to revisit

### 8.1 Risk register

| # | Risk | Likelihood / impact | When de-risked | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Next 16.4 standalone + Turbopack + pnpm isolated linker + Prisma 7 ESM client inside Docker (`Cannot find module '@prisma/client-…'`) | M / H | D1 (done in P0: image healthy, no fallback needed) | `nodeLinker: hoisted` → `next build --webpack` → non-standalone `next start` |
| R2 | Statement triggers with transition tables, the depth guard and the deferred check misbehave under Prisma `createMany` and interactive transactions | L–M / H | D1 (done in P0: TC-I00 green) | **End-of-D2 gate** (passed) → Plan B compute-on-read (D-13) |
| R3 | Shape of Prisma 7 errors for trigger SQLSTATEs (P2039, P2010, raw at COMMIT) | M / M | D1 | `readSqlState()` handles all three; unknown → 500; raw-path tests use `pg` directly |
| R4 | `prisma migrate dev` drift from hand-written SQL (sequence default, functions, partial indexes) | M / M | D1 (done in P0: no drift) | `partialIndexes` preview, else hand SQL; claim number via `SELECT public.next_claim_number()` in the same `withTx` as the INSERT (never `nextval` plus JS formatting) |
| R5 | Next.js out-of-band security release on 14 Oct (scope unknown) | Certain / M | D2 | Own commit; fallback is the patched 16.3.x line |
| R6 | Docker Desktop is stopped, and the stack needs about 6 GB RAM; Testcontainers needs Docker | Certain / H | D1, first hour (done) | Start it before anything else; raise its memory limit. Without a Docker daemon, the integration tests can use the external-DB mode (`TEST_PG_SUPERUSER_URL`) |
| R7 | New majors (Vitest 5, Testcontainers 12, TS 6) | M / M | D1 | Vitest 4.1.x; TS 5.9.3 |
| R8 | A streaming `Response` running DB batches in a route handler (aborts, held connection) | M / M | D8 | Range cap 31 days; chunk per batch; `controller.error()` |
| R9 | SeaweedFS `weed mini` behaviour | M / L (off the critical path) | D7 noon gate (the probe moved there from D1) | The full FS fallback in P6 |
| R10 | Throwing in `instrumentation.ts` `register()` doesn't stop the standalone server | M / M | D1–D2 (done in P0: the app exits 1 with owner credentials) | Explicit `process.exit(1)`, verified by test |
| R11 | Prisma rejects the double relation on `approval_steps` | L / L | D4 | Drop the plain `claim_id` FK; reach the claim via the submission |
| R12 | Overall time for a solo builder who is still learning | H / H | Daily | Gates + cut list; frontend capped at about 22–25 h; reuse one list and one `ClaimDetailView` |
| R13 | PG 18 not available on Azure Flexible Server in the target region (production only) | M / L | Docs | Switch ID defaults to Prisma `@default(uuid(7))`; nothing else changes |

### 8.2 Assumptions

- Day 1 is Tue 13 Oct 2026, with about 7 productive hours a day and no weekend work planned.
- Users are seeded only. There is no sign-up, password reset or MFA. Identity in production would come from Entra ID (ADR-0007).
- Single currency (INR) and a single business time zone (Asia/Kolkata). Changing either is a migration plus a code-constant change.
- Org-chart and policy changes happen through migrations or owner scripts (`pnpm policy:activate-tier`). ADMIN has no UI.
- Drafts may have zero lines; submission requires at least one.
- Receipts are optional for submission. A missing receipt is the approver's judgement call, not a hard rule.
- Code is hosted on GitHub (Actions). The production target (documentation only) is Azure Container Apps + a Container Apps Job + PostgreSQL Flexible Server + Key Vault with managed identity + Blob Storage + Log Analytics / App Insights.

### 8.3 Decisions to revisit (ask the RM to sign off)

| Topic | Our choice | Easy alternative |
|---|---|---|
| Decided approvers' visibility | Read-only access to the whole claim, including later revisions (accountability) | Restrict to revisions they decided on |
| Finance and drafts | Finance can read drafts ("sees everything"); the list hides them by default | Exclude drafts entirely (a one-line predicate change) |
| Recall window | Until final approval, even after intermediate approvals | Only before the first approval |
| Thresholds | ₹10,000 / ₹50,000, with L4 > ₹2,00,000 inactive | Any values; it's a data change |
| Reject reason | Required, 10 to 1000 characters; approve comment optional | Different minimum |
| Concurrent edits by the same claimant | Last write wins on a draft (the total is always DB-derived) | OPTIONAL claim `version` with 409 |
| Deactivated approver mid-chain | Claim blocks; the remedy is recall + resubmit | OPTIONAL reassign endpoint |

### 8.4 Red-team items deliberately deferred

| ID | Deferred item | Why it's acceptable now | Next step |
|---|---|---|---|
| RT-B2 (part) | A DB-level "writer = claimant" check on child writes | Identity is proven by the owner-scoped lock query (TC-I14); we have no actor GUCs by design | An actor GUC with a fail-closed check, if ever needed |
| RT-B3 (part) | A periodic drift job in production | `/api/health/ready` + `pnpm verify:integrity` exist | Schedule `pnpm verify:integrity` as a Container Apps Job (runbook) |
| RT-M1 (2) | A SQL check that the approver is the *expected* manager | TC-I16 › "stored approvers equal buildChain() for every seeded claim" (the test seeds C01–C12 itself via `seedDemoClaims()` and asserts steps exist) | `expected_reporting_line()` in `approval_steps_guard` |
| RT-M2 (residual) | Code running as `expense_app` could forge a consistent event + state change | The DB proves the state machine and audit completeness; the scoped query proves identity; D-34/D-35 limit the blast radius | pgaudit in production |
| RT-M5 (part) | Byte-identical rerun of a just-closed period | `asOf` cap + 2-minute settle window + `X-Export-Period-Open` | O1: REPEATABLE READ + `export_runs.sha256` |
| RT-M6 (residual) | The final approver's email joins live `users` | `users` is owner-only writable | Freeze the approver identity in a step snapshot |
| RT-m4 (part) | `claimant_id = actor` on insert is enforced by the service only | Owner-scoped everything afterwards | Actor GUC or a DB-side default |
| RT-m6 (part) | Scoped S3 identity (SeaweedFS admin keys locally) | Local only; ports bound to 127.0.0.1 | Managed identity with a container-scoped role (O2 / Azure) |
| RT-m9 | Splitting claims to stay under thresholds | A policy gap, not an integrity bug | Finance detective report (same claimant, overlapping dates or same receipt sha256) |

---

## 9. Requirements traceability matrix

Test IDs refer to the catalogue in [07-testing.md](docs/design/07-testing.md); decision IDs are in [§1](#1-decisions-at-a-glance).

| Req | Requirement (paraphrased) | Decision | Doc | Phase | Test(s) |
|---|---|---|---|---|---|
| Stack | Express or Next.js · PostgreSQL · Prisma | D-01, D-02, D-03, D-38 | 01 | P0 | TC-U10 › "importing @/generated/prisma from src/app fails lint"; TC-I00 |
| §1 | The total can't drift; approvers can't see claims that aren't theirs | D-12, D-26, D-34 | 03, 04 | P0–P4 | TC-I12, TC-I17 |
| §2 Claimant | Submit with lines and receipts, view own, edit rejected | D-15, D-26, D-27, D-30 | 02, 04, 05 | P2–P6 | TC-I09 › "PUT replace-set inserts, updates and deletes lines in one transaction"; TC-I22 › "a rejected claim shows reason, approver and time to the claimant and is editable"; TC-E01 |
| §2 Approver | See only routed claims; approve or reject with a reason | D-26, D-14, D-25, D-28 | 02, 04 | P4 | TC-I17; TC-I19 › "reject without a reason or with < 10 characters returns 422 VALIDATION_FAILED"; TC-I25 › "never lists claims routed to other approvers or WAITING steps" |
| §2 Finance | Export approved claims for a period; see all claims read-only | D-08, D-26, D-32 | 04, 06 | P4, P7 | TC-I18; TC-I26; TC-I28 |
| §3.1-a | One or more lines (date, category, amount, description) | D-28, D-15 | 03, 04 | P2, P3 | TC-I10; TC-I15 › "submitting a claim with zero line items returns 422 NO_LINE_ITEMS" |
| §3.1-b | Receipts per line or per claim, documented | **D-30 (per line item)**, D-31 | 06, 04, 03, 05 | P6 | TC-I27 › "owner uploads a PDF to a DRAFT line → 201 with sha256"; TC-I14 › "uploading a receipt to another claim's line returns 404" |
| §3.1-c | Total derived, never independently editable, no code path can desync | **D-12**, D-13, D-28, D-34, D-35 | 03, 04 | P0, P2 | TC-I12 › "no code path can leave claims.total_minor different from the sum of its line items"; TC-I00; TC-I13; TC-U05 › "claim bodies containing totalMinor fail with TOTAL_IS_DERIVED" |
| §3.2-a | Chain based on amount | **D-19**, D-20, D-21 | 02 | P3 | TC-U03 › "₹10,000.00 routes to 1 step", "₹10,000.01 routes to 2 steps"; TC-I16 › "₹10,000.00 → [ravi]; ₹10,000.01 → [ravi, meera]; ₹50,000.01 → [ravi, meera, vikram]" |
| §3.2-b | Thresholds documented | **D-19** (> ₹0 / > ₹10,000 / > ₹50,000 / L4 > ₹2,00,000 inactive) | 02, PLAN | P3 | TC-U03 › "₹50,000.00 routes to 2 steps", "₹50,000.01 routes to 3 steps" |
| §3.2-c | Approver sees only claims currently routed to them | **D-26**, D-29 | 04, 06 | P4 | TC-I25 › "default lists only my PENDING steps, oldest first"; TC-I18 (waiting and cancelled approver rows → 404) |
| §3.2-d | Amount change after routing started: rule documented | **D-16**, D-17, D-18 | 02, 05 | P4, P5 | TC-I21; TC-I11 › "PUT on a SUBMITTED claim returns 409 CLAIM_NOT_EDITABLE with hint RECALL_TO_EDIT"; TC-I19 › "stale revision returns 409 REVISION_MISMATCH" |
| §3.3-a | Rejected claim returns with reason, editable, resubmittable | D-15, D-16 | 02, 05 | P5, P8 | TC-I22 › "a rejected claim shows reason, approver and time to the claimant and is editable"; TC-E03 |
| §3.3-b | Reason and history not lost on edit + resubmit | **D-18**, D-22, D-31 | 02, 03 | P5 | TC-I22 › "after edit and resubmit, revision 1 snapshot, steps and reason are unchanged", "receipts referenced by revision 1 stay downloadable after the line is deleted" |
| §3.4 | Approved = read-only via UI and API | D-21, D-15, D-23, D-04 | 03, 02, 05 | P5, P6, P8 | TC-I11 › "every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED", "raw SQL as expense_app on an APPROVED claim raises UC001"; TC-I27 › "raw DELETE FROM receipts on an APPROVED claim raises UC001"; TC-E05 |
| §3.5-a | Claimants see only their own claims | D-26, D-29 | 04 | P2 | TC-I24 › "returns only the caller's claims"; TC-I18 (unrelated-employee row) |
| §3.5-b | Approvers see pending claims, plus optionally decided ones | **D-26 (decided = yes, read-only)** | 04 | P4 | TC-I18 (decided-approver row); TC-I25 › "status=APPROVED,REJECTED lists my decided steps newest first" |
| §3.5-c | Finance sees everything read-only, can't approve or reject | D-08, D-25, D-26, D-21 | 04, 03 | P4, P7 | TC-I19 › "FINANCE approve/reject returns 403 FORBIDDEN", "an approver demoted to FINANCE mid-chain is refused by the DB (UC008) even if the service check is bypassed"; TC-I26 › "lists all employees' claims, excluding DRAFT by default"; TC-U09 |
| §3.6-a | Export approved claims for a period, usable for bookkeeping | **D-32**, D-33 | 06, 04, 05 | P7 | TC-I28 › "includes only APPROVED claims approved within the period"; TC-U06; TC-E01 |
| §3.6-b | Only genuinely approved claims; in-flight or rejected never appear | D-32, D-23, D-21 | 06, 03 | P7 | TC-I28 › "partially approved, rejected, draft, recalled and resubmitted-in-flight claims never appear", "a claim approved after asOf is excluded", "backdating approved_at as expense_app raises UC010" |
| §4-a | Employees | D-08 | 03 | P0, P1 | TC-I07 › "expense_app cannot write users, departments, categories or approval_policy_tiers" |
| §4-b | Claims and their status | D-15 | 03, 02 | P0, P3 | TC-U04 › "decide() is exhaustive over status × relationship × action"; TC-I15 › "a raw invalid status transition raises UC005" |
| §4-c | Line items belonging to each claim | D-27 | 03 | P2 | TC-I12 › "moving a line to another claim is refused with UC010"; TC-I14 |
| §4-d | Record of what happened, by whom, when, why | **D-22**, D-18, D-23 | 02, 03 | P3–P5 | TC-I23; TC-I22 › "events read CLAIM_SUBMITTED(r1) → CLAIM_REJECTED(r1) → CLAIM_RESUBMITTED(r2)" |
| §4-e | Calculate vs store: pick, defend, prove no drift | **D-12**, D-13 | 03, PLAN | P0, P2 | TC-I00; TC-I12; TC-I13 › "a second writer waits on the claim lock (visible in pg_stat_activity) and the final total is 300" |
| §5 | Design the API surface | D-07, D-25, D-27, D-29 | 04 | P1+ | TC-I01; TC-I04; TC-U05; TC-U08 |
| §6-1 | Positive amount, valid date, real category; no zero-line submit | D-28, D-12 | 04, 03 | P2, P3 | TC-I10; TC-I15; TC-C01 |
| §6-2 | Specific failure for editing approved / out-of-queue approval | D-25 | 04 | P4, P5 | TC-I11; TC-I19; TC-U08; TC-I04 |
| §6-3 | Every route requires an authenticated user | D-05, D-07, D-41 | 04 | P1, P8 | TC-I01; TC-I02; TC-E04 |
| §6-4 | Sharpest: foreign claim by id refused at the query | D-26, D-14, D-03 | 04, 07 | **P2 → P4** | **TC-I17**; TC-I18; TC-E02 |
| §6-5 | Total provably impossible to desynchronise | D-12, D-34, D-35 | 03, 07 | **P0, P2** | **TC-I12**; TC-I00; TC-I13; `pnpm verify:integrity` |
| §6-6 | Queue and export filter by date range and status without loading everything | D-29, D-32, D-48 | 04, 06, 07 | P4, P7 | TC-I25; TC-I26; TC-I28; `docs/perf/explain-*.txt` |
| §6-7 | Structured trace for submission, approval, rejection | D-22, D-40 | 02, 03, 06 | P3 (submit), P4 (approve, reject), P5 (recall) | TC-I23; TC-I05 |
| §6-8 | `docker compose up` with only a documented `.env` | D-38, D-39, D-34 | 01 | P0, P8 | TC-E06; P0 exit criterion; P8 clean-clone rehearsal |
| §7-Q1 | Next approver; amount change mid-chain | D-19, D-20, D-21, D-16, D-17 | 02 | P3–P5 | TC-U03; TC-I16; TC-I21; TC-I19 |
| §7-Q2 | Read-only: UI, service or DB? | D-21, D-12, D-34 | 03, 02, 05 | P5 | TC-I11; TC-I07; TC-E05 |
| §7-Q3 | Rejected claim: preserved vs reset | D-15, D-16, D-18, D-31 | 02 | P5 | TC-I22 › "preserved vs reset: claim number, events, reasons and prior steps preserved; status, chain and editability reset" |
| §8-0 | "Don't add new features, deepen" | D-51 | PLAN | P0 | — |
| §8-1 | Second tier; variable-length chain without special-casing | D-19 (L4 row seeded inactive) | 02 | **P3 (core)** | TC-U03 › "activating the L4 tier row yields a 4-step chain with no code change"; TC-I16 |
| §8-2 | Object store pattern with signed upload URLs | D-30 (store core; signed URLs optional) | 06 | P6 / O2 | TC-I27; TC-O01 |
| §8-3 | Load test the export at 2 years; show the query plan | D-48 (core-light EXPLAIN; k6 optional) | 07, 06 | P7 / O3 | `docs/perf/*.txt`; TC-O02, TC-O03 |

---

## 10. Learning-path checkpoint map

| Learning-path stage | Where the POC demonstrates it | Phase | Proof to show the RM | Self-check question |
|---|---|---|---|---|
| **Node.js runtime** | Lazy env with exit 1 on bad config (`instrumentation.ts`); AsyncLocalStorage carries `requestId` across `await`; pull-based stream backpressure in the export; argon2id runs on the libuv threadpool; graceful shutdown (`init: true`, `stop_grace_period`) | P0, P1, P7, P8 | The container exits non-zero with a broken `.env`; one `requestId` appears on every log line of a request | "Why doesn't a one-year export block other requests?" |
| **HTTP and REST APIs** | `/api/v1` resources; GET/POST/PUT/DELETE semantics; the 401 → 403 → 404 → 409 → 422 ladder; headers `x-request-id`, `Cache-Control: no-store`, `Content-Disposition`, `Set-Cookie`; path vs query params | P1–P7 | README route table; `curl -i` demos | "Why 409 and not 400 for editing an approved claim?" (The request is valid; the claim's state conflicts with it) |
| **PostgreSQL fundamentals** | uuidv7 PKs; composite FKs; CHECKs; partial and unique indexes; triggers; two roles and grants; transactions; `FOR NO KEY UPDATE`; EXPLAIN | P0, P2–P5, P7 | psql session (UC003, UC001, 42501); EXPLAIN before/after | "What does `FOR NO KEY UPDATE` lock, and why not `FOR UPDATE`?" |
| **Prisma ORM** | `schema.prisma` relations; `migrate dev --create-only` + hand SQL; typed CRUD; interactive transactions; tagged `$queryRaw` for row locks; the `PrismaPg` adapter; error-code mapping | P0–P4 | Walk through the migrations folder: what Prisma models vs what lives in raw SQL | "What doesn't Prisma model, and how do you stop drift?" |
| **CRUD** | Claim create (201), read (200), replace-set (200), delete draft (204); missing → 404 | P2 | TC-I09, TC-I10 | "What does DELETE return for a submitted claim?" (409 `CLAIM_HAS_HISTORY`) |
| **Pagination, sorting, filtering** | Keyset cursors on three lists and the export; strict query schemas (unknown param → 422); IST ranges; `page` metadata; no COUNT | P2, P4, P7 | "Pages complete and disjoint" tests; EXPLAIN Index Scan with no Sort | "Why no total count, and why not OFFSET?" |
| **Validation** | Shared strict Zod 4 for body, query and params, used by forms and server; string-math money; date rules; DB backstops | P2+ | TC-I10 table; a 422 `issues[].path` landing on the right form field | "What happens if I send `totalMinor`?" |
| **Error handling** | `AppError` + catalogue; one mapper for Zod, Prisma codes and UC SQLSTATEs; envelope with `requestId`; generic 5xx | P1 | TC-I04, TC-U08 | "How does a trigger exception become a 409 with a specific code?" |
| **Authentication (incl. JWT/Entra concepts)** | Opaque DB sessions; argon2id; cookie flags; idle and absolute expiry; Origin-based CSRF. JWT and Entra (OIDC code + PKCE, `oid` mapping, JWKS validation for machine clients) in ADR-0007 | P1, P8 | TC-I02, TC-I03; ADR-0007 | "Why not JWT for our own sessions?" |
| **Authorization** (Important) | Role gates + resource-level rules (owner, routed approver, finance read-only); pure `decide()` drives both enforcement and `allowedActions`; actor-scoped repositories; Prisma import restriction | P2, P4 | TC-I17 (sharpest), TC-I18 matrix | "If I delete every role check from the React code, what breaks?" (Only the look of the UI) |
| **Next.js path** | Route Handlers as the single interface; Server Components render only the shell; Server Actions banned deliberately (lint + ADR-0001); tRPC considered and rejected; `proxy.ts` for UX only | All | ADR-0001, ADR-0002 | "When would you use Server Actions, and what would you have to add?" |
| **Common engineering flow** | `defineRoute`: requirement → validation → authorization → logic → database → response → logging → testing | P1 | Trace one submit: request, log lines, event row, test | — |
| **Delivering a vertical slice** | Every phase P2–P7 ships DB + API + UI + tests together | All | Phase exit checklists in this plan | — |
| **Automated testing** | Unit (money, `buildChain`, `decide`, CSV); integration on real PG as the app role; component (editor); E2E against compose; authz tests; regression invariant via `afterEach` | All | `pnpm verify` output; Playwright report | "Why not mock Prisma?" (Mocks can't prove a trigger fires or a lock is taken) |
| **Structured logging** | pino JSON, levels, redaction, request ids via ALS, `claim_events.request_id`, `defense: 'db'` error logs | P1 | Grep one `requestId` across the logs and its event row | "Logs or the audit table: which answers a finance dispute?" |
| **Docker fundamentals** | Multi-stage Dockerfile, standalone output, non-root user, HEALTHCHECK, `depends_on` conditions, one-shot migrate job, `.env` | P0, P8 | `docker compose down -v && up --wait` from clean | "Why aren't migrations run in the app's entrypoint?" |
| **Azure production fundamentals** | Documentation mapping: Container Apps (app) + Container Apps Job (migrate), PostgreSQL Flexible Server, Key Vault + managed identity, stdout → Log Analytics, App Insights via OTel (O4), Blob adapter behind `ReceiptStorage` | P8 | README Azure section | "Where do secrets live in production, and who can read them?" |
| **OpenTelemetry** (reference) | Optional O4: `@vercel/otel` + Prisma instrumentation + Jaeger | BUF | Trace screenshot if built | — |
| **EXPLAIN** (reference) | Core-light: perf seed with triggers on + before/after plans | P7 | `docs/perf/*.txt` | "What changed between the before and after plans?" |
| **AI-assisted workflow** | Plan before coding (this plan + design docs); review against the red-team ledger; verify by tests | All | This PLAN, ADRs, test suite | "Which generated code did you have to correct, and how did you know?" |
