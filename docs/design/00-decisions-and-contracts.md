# CANONICAL DECISIONS & CONTRACTS — Expense Claims and Reimbursement POC

> **Status: AUTHORITATIVE.** Written 2026-10-13 by the chief architect / consistency arbiter.
> Every plan and design-doc writer follows this file **verbatim**. Where any `design_*.md` disagrees with this file, this file wins; the design sections are now *rationale*, not spec.
> Tie-break rule used throughout: (1) strongest on integrity and authorization, (2) simplest to explain in the walkthrough, (3) feasible in 10 solo days. Nothing that requirements §6 checks is demoted.
> Classification: **CORE** = in the planned phases P0–P8. **OPTIONAL-§8** = a requirements §8 stretch item, done in the buffer (BUF). **OPTIONAL** = other stretch, buffer only. **NOT PLANNED** = documented as a next step only.
> Phase ids (P0–P8, BUF) are defined in [C-24](#c-24-phases-and-calendar).
>
> **Errata from the SQL proof (later than this register; these win over the text below).** The integrity SQL was then run on a real PostgreSQL ([reference/sql-proof](../reference/sql-proof/README.md), 127/127). Where this register disagrees with the **verified SQL in [03 §16](./03-data-model-and-integrity.md#16-verified-sql-migration-by-migration)**, 03 wins:
> - **BUG-1 (claim numbers).** `claims_guard` does **not** blindly force `claim_number := next_claim_number()` for `expense_app` (D-23, C-04 #4). That drew two sequence values per claim. It keeps the default-drawn number only if it equals this session's `currval`-formatted number, otherwise it draws a fresh one; a client-supplied number is never kept.
> - **BUG-2 (snapshot freeze).** Once a submission with `revision > current_revision` exists, the claim's lines, receipts and title are frozen (UC002) even before the status flip. At →SUBMITTED, `claims_guard` re-checks the snapshot's total, line count and title (UC016).
> - **BUG-3 (error precedence).** The transition whitelist (UC005) is checked before the DB-owned-timestamp rule (UC010), so an illegal transition reports 409, not 500.
> - **Roles script (D-36, C-08, RT-M10).** Use `REVOKE ALL ON DATABASE … FROM PUBLIC` and `REVOKE ALL ON SCHEMA public FROM PUBLIC` (supersets of the REVOKE TEMPORARY / REVOKE CREATE wording below), then `GRANT CONNECT` / `GRANT USAGE` to `expense_app`.
> - **TC-I20.** The race case is named "approve racing recall: on the final level exactly one wins; on an intermediate level both succeed in lock order; status, steps and events agree". A single winner exists only for the **final** approval. At an intermediate level both requests succeed in lock order, because recall is legal until the final approval. See [07](./07-testing.md).
>
> **Errata from the plan review and the P0 build (also win over the text below).**
> - **Schedule.** Days and dates live only in [PLAN §4–§5](../../PLAN.md#4-phase-wise-plan); [C-24](#c-24-phases-and-calendar) keeps phase scopes. Gate times (Plan B, storage, e2e) are in [PLAN §5 Decision gates](../../PLAN.md#decision-gates).
> - **Contracts added:** [C-26](#c-26-repository-and-service-signatures) (repository and service signatures, `ServiceCtx`, `SeedClock`). The seed is split into an always-run `seedReference()` and the gated demo seed (D-45). Drift = `pnpm db:deploy && pnpm db:diff-check`, no shadow DB (D-37). TC-E04 is CORE. C-23 now names `assert_claim_editable` v2 (P3, BUG-2) and `claim_submissions_verify` v2 (P6), which the migration checklists had left out.
> - **P0 as built.** Tailwind 4 is wired through the `@tailwindcss/turbopack` loader in `next.config.ts` (no `postcss.config.mjs`, no `@tailwindcss/postcss`). Base images are digest-pinned (C-12). The pages lint zone is a regex, because a negated `group` pattern can't re-include `@/server/auth/rsc` ([01 §7.2](./01-architecture-and-stack.md#72-eslintconfigmjs)). The postgres healthcheck probes TCP (`pg_isready -h 127.0.0.1`), because during initdb Postgres listens only on the socket. Under `tsx` in this `"type": "module"` repo, scripts import `@next/env` as a default import (`import nextEnv from '@next/env'; nextEnv.loadEnvConfig(…)`). The test harness can use an external empty PG 18 via `TEST_PG_SUPERUSER_URL` (Testcontainers stays the default). Prisma 7.10's `migrate reset` refuses to run under an AI agent unless the user consents (`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`). Details in [01](./01-architecture-and-stack.md).

Contents
- [A. Decisions register](#a-decisions-register) (D-01 … D-52)
- [B. Resolution log](#b-resolution-log) (every cross-section contradiction)
- [C. Red-team ledger](#c-red-team-ledger) (every red-team finding → FIXED-BY-DESIGN or DEFERRED)
- [D. Contracts (verbatim)](#d-contracts-verbatim) (C-01 … C-26)

---

## A. Decisions register

Format: **Decision** · **Why** (what to say in the walkthrough) · **Rejected** · **Class** · **Owning doc** (`docs/design/0N-*.md`, PLAN = `PLAN.md`).

### Platform and architecture

**D-01 One Next.js App Router app, REST Route Handlers are the only interface** — CORE · Doc 01
- Decision: Single folder, single image, Next.js 16.4 App Router + TypeScript. Every read and write the UI makes goes `HTTP /api/v1 route → service → repository → Postgres`. Server Actions and `'use cache'` are banned by ESLint; `cacheComponents: false`; `output: 'standalone'`.
- Why: One deployable, one auth model, one set of shared Zod schemas, and exactly one door into the data that Vitest, curl and Playwright all test — including the §6 "approver by ID" test.
- Rejected: Express API + Vite SPA (two deployables, CORS/cookie plumbing); tRPC (RPC semantics instead of HTTP status codes); Server Actions (implicit public endpoints, a second enforcement path); accepting the 16.4 Cache Components default (cross-user cache-leak risk, nothing cacheable).

**D-02 Pinned versions = the stack designer's web-verified set** — CORE · Doc 01
- Decision: Exact pins in [C-12](#c-12-pinned-versions); committed lockfile; `pnpm` 10 `onlyBuiltDependencies`. On **Wed 14 Oct 2026** (the advisory's release date) bump `next`, `@next/env`, `eslint-config-next` to the 16.4.x out-of-band security patch (exact number unknown today) as its own commit; fallback is the patched 16.3.x line.
- Why: Versions were checked against registries on 2026-10-12: Prisma 7.10 (v8 is RC and lacks isolation levels/P2002 codes), TS 6.0.3 (TS 7 has no API for type-aware lint), PG 18.6 (native `uuidv7()`).
- Rejected: Prisma 8 RC; TS 7.0; floating ranges; Alpine images.

**D-03 Layering and import boundaries enforced by lint** — CORE · Doc 01
- Decision: `src/app/api/**/route.ts` → `src/server/services/**` → `src/server/repositories/**` → Prisma. Only `src/server/repositories/**` and `src/server/db/**` may import `@/server/db/client` or `@/generated/prisma/*`. Services never import `next/*`. `src/shared`, `src/lib`, `src/components`, `src/features` never import `@/server/**`. Pages/layouts may import only `@/server/auth/rsc`. `$queryRawUnsafe` / `$executeRawUnsafe` banned. Folder layout in [C-18](#c-18-folder-layout-and-module-names).
- Why: The architecture becomes a build failure, not a convention; "the UI cannot touch the database" is provable by a lint fixture.
- Rejected: convention only; Biome (no path-zone boundaries or Next plugin parity).

**D-04 Data fetching: client components + TanStack Query over `/api/v1`; RSC renders the shell only** — CORE · Doc 05 (security angle Doc 04)
- Decision: Server Components do **no data reads**; `(app)/layout.tsx` calls `getActor()` (identity, nav, redirect). All claim/approval/finance data flows through `/api/v1` via TanStack Query. Defense in depth: every service function takes `ctx: ServiceCtx` carrying the `Actor` ([C-26](#c-26-repository-and-service-signatures)) and enforces its own role (`requireRole(actor, 'FINANCE')` is the first line of every `finance.service` and `export.service` function; `financeClaimsWhere(actor)` throws `FORBIDDEN` unless FINANCE).
- Why: One read path, and it is the tested path; a page can never show what the API would refuse. Services that self-guard stay safe even if someone later adds an RSC read.
- Rejected: RSC reads through services (second read path); RSC fetching its own API (self-request hop); Server Actions.

**D-50 Frontend kit and forms** — CORE · Doc 05
- Decision: Tailwind 4 + shadcn/ui (copy-in), native `<input type=date>` and native `<select>`, react-hook-form `useFieldArray` (server id kept as `lineItemId` because RHF reserves `id`), shared Zod via `zodResolver`, filters in the URL parsed by the same shared query schemas (own `useUrlQuery` hook), `useInfiniteQuery` + "Load more", no optimistic updates for totals/status, mutations never auto-retry, buttons rendered only from server `allowedActions`. React Compiler off. Frontend budget capped at ~22–25 h: one list component reused 3×, one `ClaimDetailView` reused 3×.
- Why: React engineer's home turf; integer/strings-only money; the UI never re-implements the state machine.
- Rejected: MUI/Chakra; nuqs (redundant with Zod parsing); date-picker libraries; client-side role/status `if` logic; optimistic money.

### Identity and access

**D-05 Authentication: hand-rolled opaque DB sessions** — CORE · Doc 04
- Decision: Password login (seeded users only) → 32 random bytes, base64url token in an HttpOnly cookie; DB stores `sha256(token)` hex in `sessions`. argon2id via Node 24 built-in `crypto.argon2` (PHC string). Idle timeout 60 min sliding (expiry refreshed at most every 5 min), absolute 12 h; new token on every login (fixation-safe); logout deletes the row; deactivation deletes all the user's sessions and is also checked per request; role/canApprove read live from `users` on every request. Cookie name from one function `sessionCookieName(appBaseUrl)`: `__Host-ec_session` (https, `Secure`) or `ec_session` (http localhost); `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`. Login returns **200 `{data:{user}}` + Set-Cookie**. Unknown email, wrong password and inactive user return an identical 401 `INVALID_CREDENTIALS`. **No `AUTH_SECRET`.** Entra ID (OIDC code+PKCE, map by `oid`+`tid`, never by email, then the same `createSession()`) is ADR text only.
- Why: ~150 explainable lines; instant revocation and always-current roles because we hit Postgres on every request anyway; tests authenticate with one `createSession(userId)` helper.
- Rejected: Better Auth (80% unused, own tables/routes/error shape); Auth.js v5 (beta; credentials login forces JWT); self-issued JWT sessions (no revocation without a DB denylist).
- OPTIONAL: login rate limiting (`rate_limit_buckets`, 429 `RATE_LIMITED`), dummy-hash timing equalisation, NIST password policy (no password-setting endpoint exists in core), Entra code.

**D-06 CSRF and security headers** — CORE · Doc 04
- Decision: `SameSite=Lax` + Origin / `Sec-Fetch-Site` check on POST/PUT/PATCH/DELETE (403 `CSRF_REJECTED`; requests with no Origin header are allowed) + JSON-only bodies (a request that carries a body must be `application/json`, else 415; bodyless POSTs such as `/submit` are fine; the one multipart route requires `multipart/form-data`) + no CORS headers ever. The export GET also rejects `Sec-Fetch-Site: cross-site` (403 `CSRF_REJECTED`). Static security headers in `next.config.ts` (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`), `poweredByHeader: false`.
- Why: Layered defense with no token plumbing in React.
- Rejected: synchronizer/double-submit tokens. OPTIONAL: nonce-based CSP in `proxy.ts` (forces dynamic rendering, easy to break).

**D-07 Route wrapper and request pipeline** — CORE · Doc 04
- Decision: `defineRoute({ auth: 'required' | 'public', roles?, params?, query?, body?, handler })` in `src/server/http/define-route.ts`, tagging the export with `ROUTE_META = Symbol.for('expense.routeMeta')`. Pipeline order: request id → authenticate (401) → CSRF origin check on unsafe methods (403) → role gate (403 `FORBIDDEN`) → path params (malformed UUID → 404 resource code) → content type (415) → query/body Zod (422) → service → error mapping → access log. Auth reads the cookie from `NextRequest.cookies` only (never `next/headers`). `proxy.ts` (matcher excludes `/api`) only does the optimistic page redirect using `sessionCookieName()`; deleting it changes nothing about API security. Public routes are one exported constant `PUBLIC_ROUTES` shared by the inventory test and `proxy.ts`.
- Why: Authentication happens inside every handler (CVE-2025-29927 showed middleware can be skipped), the inventory test can enumerate it, and every later route gets auth, validation, errors and logging for free.
- Rejected: `authed()`/`publicRoute()`, `withApi()` (same idea, renamed — one name only); auth in middleware/proxy.

**D-08 Roles model and segregation of duties** — CORE · Doc 04 (schema Doc 03)
- Decision: `users.role` ∈ {EMPLOYEE, FINANCE, ADMIN} + `users.can_approve boolean` + `users.is_fallback_approver boolean`. `CHECK (NOT (role = 'FINANCE' AND can_approve))`; `CHECK (NOT is_fallback_approver OR can_approve)`; partial unique index → at most one fallback approver. Every user can file their own claims. "Approver" = `can_approve`. ADMIN has **no** UI and **no** extra visibility; policy and org data change only via migrations or owner scripts. `Actor = { id, email, name, role, canApprove }`. See [C-01](#c-01-roles-and-actor).
- Why: Finance-can't-approve becomes a row CHECK instead of a runtime hope; every predicate is a single-column test.
- Rejected: `user_roles` join table + exclusion trigger; `roles[]` array.

**D-25 The 401 → 403 → 404 → 409 → 422 ladder** — CORE · Doc 04
- Decision (in order): 401 `UNAUTHENTICATED` → 403 `CSRF_REJECTED` → 403 `FORBIDDEN` (persona role gate: `/approvals` and approve/reject need `canApprove && role ≠ FINANCE`; `/finance/*` needs FINANCE) → 404 for a malformed path UUID → 415 / 422 request shape → **reads and owner-writes on a claim you can't see/own: 404 `CLAIM_NOT_FOUND`**, byte-identical to a random UUID (finance mutating someone's claim gets 404 too) → **approve/reject with no PENDING step for you: 403 `NOT_IN_YOUR_QUEUE`** (uniform for nonexistent ids, so no oracle) → 409 state conflicts (`CLAIM_LOCKED`, `CLAIM_NOT_EDITABLE`, `INVALID_STATUS_TRANSITION`, `ALREADY_DECIDED`, `REVISION_MISMATCH`, `CLAIM_HAS_HISTORY`, `CONFLICT`) → 422 DB-dependent business rules (`NO_LINE_ITEMS`, `CATEGORY_INACTIVE`, `ROUTING_UNRESOLVABLE`, …).
- Why: "If you can't see it, it doesn't exist; if you can see it but your role/queue forbids it, a specific 403; if the claim's state forbids it, a specific 409." Satisfies §6 "clear, specific failure" without an existence oracle.
- Rejected: 403 for every invisible claim (oracle); 404 for out-of-queue approvals (less specific than §6 asks); `NOT_CLAIM_OWNER` / `FORBIDDEN_ROLE` / `FINANCE_CANNOT_APPROVE` synonyms.

**D-26 Visibility predicate and "refused at the point of the query"** — CORE · Doc 04
- Decision: One module `src/server/repositories/claim-visibility.ts` exports `claimVisibilityWhere(actor)` = `claimant_id = me` OR `EXISTS step (approver_id = me AND status IN ('PENDING','APPROVED','REJECTED'))` OR `actor.role = 'FINANCE'`. It is AND-composed (`{ AND: [{ id }, claimVisibilityWhere(actor)] }`) into every claim read, the history read and every receipt read; children are only reached through the scoped claim. WAITING and CANCELLED-without-decision steps grant nothing. Writes use owner-scoped lock queries (`claimant_id = me`); decisions use the PENDING-scoped lock (D-14). There is no unscoped `findClaimById` anywhere. Decided approvers keep read-only access to the whole claim (all revisions) — §3.5 "optionally" taken as yes, for accountability. Finance sees **all** claims including drafts (spec: "sees everything"), read-only; the finance list hides DRAFT unless `status=DRAFT` is requested.
- Why: An out-of-scope id returns `null` from Postgres itself — that *is* "refused at the point of the query".
- Rejected: load-then-check in the service; UI hiding; `activated_at IS NOT NULL` predicate (leaks to cancelled approvers); finance-excludes-drafts (contradicts "sees everything"; flipping it is one line).

**D-46 PostgreSQL Row-Level Security** — NOT PLANNED · Doc 04
- Decision: Not built. Documented as the next hardening step.
- Why: The AND-composed predicate already meets §6; RLS would double the authorization surface and force every Prisma read into an interactive transaction.
- Rejected: RLS as core; RLS as a buffer item (lowest value per hour).

### Domain and workflow

**D-15 Claim lifecycle** — CORE · Doc 02
- Decision: Claim statuses DRAFT, SUBMITTED, APPROVED (terminal, immutable), REJECTED. Editable iff DRAFT or REJECTED (REJECTED stays REJECTED while edited so the banner stays). One `/submit` endpoint for first submit and resubmit; every submission is a new revision with a fresh chain. Draft deletion only when never submitted (`current_revision = 0`). Transitions and actions in [C-02](#c-02-enums) and [C-07](#c-07-api-routes).
- Why: Four statuses map 1:1 to §3; one submit path means one chain builder to test.
- Rejected: IN_REVIEW/IN_APPROVAL statuses; moving REJECTED to DRAFT on first edit; WITHDRAWN status.

**D-16 Recall and the amount-change rule (§3.2)** — CORE · Doc 02
- Decision: Line items, title and receipts are **not editable while SUBMITTED** (409 `CLAIM_NOT_EDITABLE`, `details.hint = 'RECALL_TO_EDIT'`; DB UC002). To change anything the claimant **recalls** (allowed while SUBMITTED, i.e. until the final approval, even after intermediate approvals): open (PENDING/WAITING) steps → CANCELLED (kept), APPROVED steps stay in history against that revision, claim → DRAFT. The next submit builds a **brand-new chain from the new total**; earlier approvals never carry over.
- Why: Content is frozen while approvers look at it (no TOCTOU), there is one chain builder, and the DB rule is one line (editable iff DRAFT/REJECTED). Approvals bind to content, not to an amount bucket.
- Rejected: edit-before-first-approval with auto re-route (two chain builders, approver TOCTOU, conditional DB guard); keeping approvals if the tier count is unchanged; recall only before the first approval.

**D-17 Revision pinning on decisions** — CORE · Doc 02 (API Doc 04)
- Decision: Approve and reject bodies **require `revision`** (the revision the approver reviewed). Under the claim lock, `body.revision ≠ claims.current_revision` → 409 `REVISION_MISMATCH` `{requestedRevision, currentRevision}`. Claimant-side optimistic `version` on PUT/submit is OPTIONAL (last-write-wins between two tabs of the *same claimant* on a draft is documented and harmless because the total is always DB-derived).
- Why: After recall + resubmit the same L1 may be PENDING again with a stale tab open; one integer stops them signing content they never saw (same idea as `If-Match`).
- Rejected: `expectedRevision` naming; `STALE_REVISION` / `CLAIM_REVISION_CHANGED` codes; step-id-addressed decision routes.

**D-18 Submission snapshot: service-built, DB-verified, append-only** — CORE · Doc 02 (SQL Doc 03)
- Decision: Under the claim lock the service builds the snapshot JSON ([C-21](#c-21-submission-snapshot-json-v1)) and inserts `claim_submissions`. The BEFORE INSERT trigger `claim_submissions_verify` refuses unless: claim status ∈ {DRAFT, REJECTED}; `revision = claims.current_revision + 1`; `submitted_by_id = claims.claimant_id`; snapshot has ≥ 1 line (UC004); the snapshot's line set `(lineItemId, amountMinor, categoryId, expenseDate)` equals the live `line_items` of the claim exactly, `Σ amountMinor = NEW.total_minor = claims.total_minor`, `line_item_count` matches (UC016). For `expense_app` it stamps `submitted_at := now()`. The table is INSERT-only (no UPDATE/DELETE grant + `forbid_mutation`, UC007). Submission outcome is **derived** by the pure `submissionOutcome(steps)`: any REJECTED → REJECTED; all APPROVED → APPROVED; any CANCELLED with none REJECTED → RECALLED; else IN_APPROVAL. The snapshot also freezes claimant identity and each line's category name + GL code, which the export uses (D-32).
- Why: The app cannot forge "what was submitted" (the DB checks it against the live rows), history survives every later edit (§3.3), and there is far less PL/pgSQL than a DB-built snapshot.
- Rejected: DB-built snapshot via `jsonb_agg` in a trigger (more PL/pgSQL); app-built unverified snapshot (forgeable); UPDATE of `outcome`/`closed_at` (breaks append-only).

**D-19 Routing policy model: ordered, data-driven tiers with exclusive thresholds and a per-tier resolver** — CORE (T4 demo row = OPTIONAL-§8 delivered in core) · Doc 02
- Decision: One table `approval_policy_tiers(level, code, label, applies_above_minor, resolver, levels_up, designated_user_id, is_active)`. **The chain = every active tier with `claim total > applies_above_minor`, ordered by `level`, each mapped through its own resolver.** No `if (amount > X)` exists in code; adding a tier is inserting a row. Thresholds are exclusive lower bounds in paise ([C-13](#c-13-approval-thresholds-paise)). `assertPolicyWellFormed(tiers)` (pure; run at seed, in the owner script, in a unit test, and at boot through `assertPolicyLoadsWellFormed()` in `src/server/routing/policy.ts` — `tiersRepo.listAll()` as `expense_app` → `assertPolicyWellFormed`, step 4 of `instrumentation.ts`, wired in P3): active levels contiguous 1..N, level 1 has threshold 0, thresholds strictly increase, resolver columns consistent, `levels_up` 1..5. Single currency (INR) in the POC. In-flight chains never change: each step copies `tier_code`, `tier_label`, `applies_above_minor` at submit. `expense_app` has **SELECT only** on tiers; tier changes ship as migrations or the owner script `pnpm policy:activate-tier <CODE>`.
- Why: §8 "variable-length chain without special-casing" is literally a filter over rows; the walkthrough answer to Q1 is "a row lookup plus a resolver, materialised as rows at submit".
- Rejected: min/max bands with `approval_levels` + contiguity trigger (UC015/UC017 in the old data design); versioned `approval_policies` table (no consumer in a POC); hard-coded thresholds; rules engine.

**D-20 Approver resolution and edge cases** — CORE · Doc 02
- Decision: Pure `buildChain({ tiers, claimant, org, totalMinor })` in `src/server/routing/build-chain.ts`. Per tier, an ordered candidate list: (1) **primary** — `REPORTING_LINE`: the claimant's `levels_up`-th manager (null if the line is shorter); `DESIGNATED_USER`: the designated user; (2) **escalation** — the primary's managers walking upward (cycle-safe, max 25 hops); (3) **fallback** — the user with `is_fallback_approver`. The first **eligible** candidate wins: `is_active AND can_approve AND role ≠ 'FINANCE' AND id ≠ claimant AND not already in this chain`. Each step records `resolved_via ∈ {PRIMARY, ESCALATED, FALLBACK}`. If no candidate is eligible → **422 `ROUTING_UNRESOLVABLE` `{tierCode, level}`**, the transaction rolls back, nothing changes, never auto-approve, never drop a tier. Same person for two tiers → escalate to the next distinct person (`UNIQUE(submission_id, approver_id)`). Org-chart or policy changes after submit don't touch in-flight chains ("routed per the org chart as of submit"). A deactivated approver's step blocks the claim; day-one remedy is recall + resubmit; the "stuck steps" admin query lives in the runbook; reassign endpoint is OPTIONAL. Skipped-candidate reasons are **not** stored or shown (HR-status privacy).
- Why: One uniform rule covers missing managers, self-approval, finance managers and duplicates; N tiers always means N distinct signatures (four-eyes).
- Rejected: auto-approve when unresolvable; collapsing duplicate approvers; lazy re-resolution at decision time; storing `skipped[]` traces.

**D-21 DB backstops for routing and decisions** — CORE · Doc 03 (rules Doc 02)
- Decision: `claims_guard` on →SUBMITTED requires the current submission's step count = number of active tiers with `applies_above_minor < total_minor`, levels exactly 1..n, level 1 PENDING with `activated_at`, others WAITING (UC012). `approval_steps_guard`: on INSERT the approver is eligible (UC008) and the step belongs to the claim's newest submission while the claim is still DRAFT/REJECTED (UC012); WAITING→PENDING only after the previous level is APPROVED (UC012); on PENDING→APPROVED/REJECTED it **re-checks eligibility at decision time** (`is_active AND can_approve AND role ≠ FINANCE AND ≠ claimant`, UC008); decided/cancelled steps are immutable (UC006); `approver_id/level/submission_id/claim_id` immutable (UC010). →APPROVED requires every step of the current submission APPROVED (UC011).
- Why: Under-approval (a ₹75,000 claim with one signature) is impossible even from raw SQL or a `buildChain` bug, and a finance promotion mid-chain can't produce a finance approval.
- Rejected: `v_steps BETWEEN 1 AND required` (allows short chains); eligibility checked only at insert. DEFERRED: a SQL `expected_reporting_line()` check that the approver is the *right* manager (covered by a test comparing stored approvers to `buildChain()` for every seeded claim; TC-I16 seeds C01–C12 itself with `seedDemoClaims()` and asserts `approval_steps` is non-empty, so it can't pass on zero rows).

**D-22 Audit trail: ONE writer — the service, in the same transaction — with DB guarantees** — CORE · Doc 02 (catalogue), Doc 03 (SQL)
- Decision: Services call `recordEvent(tx, ctx, event)` (`src/server/audit/record-event.ts`) exactly once per state-changing request, in the same transaction, after the state writes. The event is validated by a Zod discriminated union ([C-20](#c-20-audit-event-catalogue)). `actor_id` is the authenticated actor; `request_id` is the request's `x-request-id`. DB guarantees: (1) `expense_app` has SELECT + INSERT only; `forbid_mutation` raises UC007 on UPDATE/DELETE; (2) for `expense_app` the insert branch stamps `occurred_at := now()` and `tx_id := pg_current_xact_id()`; (3) **deferred constraint trigger `assert_transition_audited`** on `claims` (AFTER UPDATE OF status) and `approval_steps` (AFTER UPDATE OF status to APPROVED/REJECTED) refuses COMMIT (UC015) unless an event exists **in this transaction** for that claim with the matching `from_status/to_status/revision` (claims) or `step_id` (steps), and with `actor_id = claimant_id` for submit/resubmit/recall and `actor_id = approver_id` for decisions. Draft edits are not audited (snapshots capture them). Logs mirror events after commit.
- Why: Services can't forget (COMMIT fails), can't edit or delete history, and the event carries the real authenticated actor plus a rich typed payload. One writer, one obvious place to read the trace.
- Rejected: SECURITY DEFINER trigger-written events + `app.actor_id`/`app.request_id` GUCs (actor derived from data, GUC spoofable and fail-open, extra seed role, poorer payloads); both writers at once (double events / 42501 failures); logs as the audit trail.

**D-23 Transition timestamps are owned by the database for the app role** — CORE · Doc 03
- Decision: When `current_user = 'expense_app'`, triggers stamp `now()` (transaction start, so every row in one transition shares one instant) into `claims.submitted_at/approved_at/rejected_at`, `claim_submissions.submitted_at`, `approval_steps.activated_at/decided_at/cancelled_at`, `claim_events.occurred_at`, and force `claims.created_at`; app-supplied values are overwritten. Changing those columns outside their transition raises UC010. For any other role (the owner-run seed and perf generator) supplied values are kept and missing ones default to `now()`. Every role must insert a claim as an empty DRAFT (revision 0, total 0); for `expense_app` inserts `claims_guard` also forces `claim_number := next_claim_number()` (keeping a matching default-drawn number, see the BUG-1 erratum). Production requests carry no clock, so services supply no transition timestamps; only the owner-run seed sets `ServiceCtx.clock` (a `SeedClock`, [C-26](#c-26-repository-and-service-signatures)), and services then forward `clock.now()` into those columns ([02 §9](./02-domain-and-workflow.md#9-service-sketches)).
- Why: No code path can backdate an approval into an already-exported period; the seed can still build realistic history because it runs as the owner in the migrate job.
- Rejected: injected app `Clock` for production paths (backdatable); `dbNow()` read then written by the app; a third `expense_seed` role (unneeded: seeds already run as owner).

### Data integrity

**D-12 Claim total: stored, maintained only by Postgres, guarded three ways** — CORE · Doc 03 (THE core hard case)
- Decision: `claims.total_minor` is written **only** by three AFTER STATEMENT triggers on `line_items` (INSERT/UPDATE/DELETE, transition tables) sharing `line_items_recompute_claim_totals()`: lock affected claims `ORDER BY id FOR NO KEY UPDATE`, then `UPDATE claims SET total_minor = (SELECT COALESCE(SUM(amount_minor),0) …)` — full recompute, never deltas; the UPDATE branch recomputes old and new parents. **Guard:** `claims_guard` raises UC003 when `total_minor` changes at `pg_trigger_depth() < 2` or a claim is inserted with total ≠ 0 (all roles). **Commit-time backstop:** `assert_claim_total_consistent()` as DEFERRABLE INITIALLY DEFERRED constraint triggers on `line_items` and `claims` raises UC009 if `total_minor ≠ Σ lines` at COMMIT. **Auditor:** view `v_claim_total_drift` (must always be empty; `pnpm verify:integrity`). App layers: strict Zod refuses any total key (422 `TOTAL_IS_DERIVED`); no service writes the column. Privileges make the guards unbypassable for the app's credentials (D-34).
- Why: Routing, queue, sort and export need a cheap stable number and approvals need a frozen one; putting it under DB control makes every path (API, Prisma nested/bulk writes, raw SQL, COPY, MERGE, concurrency) go through the same enforcement, and the commit-time check catches even a sabotaged primary mechanism.
- Rejected: compute-on-read only (no index/sort, still need a frozen number); app-maintained total (bypassable by any path that forgets); delta triggers (not self-healing); generated column / materialized view (impossible / stale); transaction-local GUC origin flag (spoofable); SECURITY DEFINER + current_user gate (equal strength, more moving parts); the `forbidDerivedWrites` Prisma extension (OPTIONAL — redundant fourth layer that also breaks other models' `totalMinor`).

**D-13 Plan B gate for the total** — CORE · Doc 03, PLAN
- Decision: If the five P0 spike tests (a)–(e) are not green by the **Plan B gate** ([PLAN §5](../../PLAN.md#decision-gates)), switch to compute-on-read: view `claims_with_totals`, plus `claim_submissions.total_minor` stored immutably and verified against the snapshot at insert. The §6 desync test then asserts "there is no mutable stored total, and submitted totals are verified at insert".
- Why: §4 allows either design; a hard gate stops the core hard case eating the schedule.
- Rejected: no fallback.

**D-14 Concurrency and locking recipe** — CORE · Doc 02 (SQL Doc 03)
- Decision: READ COMMITTED everywhere. Every mutation runs in `withTx(fn)` (Prisma interactive transaction, `maxWait 5000`, `timeout 10000`) and **first** takes an **actor-scoped** row lock on the claim with `SELECT … FOR NO KEY UPDATE`: owner actions `lockOwnedClaim(tx, actor, claimId)` (`claimant_id = me`), decisions `lockClaimRoutedToMe(tx, actor, claimId)` (`EXISTS step approver_id = me AND status = 'PENDING'`, `FOR NO KEY UPDATE OF c`). Then **re-read** facts with a fresh statement, decide, write with conditional updates that expect `count = 1`. Lock order: claim → submission → steps → events; child-row triggers also lock the parent claim `FOR NO KEY UPDATE`. Role checks happen before the transaction, so out-of-scope actors never take a lock. Retries: 40001/40P01 (and Prisma P2034) retried up to 2 times, then 409 `CONFLICT`; 55P03 (`lock_timeout 5s` role setting) → 409 `CONFLICT`. No network I/O inside transactions.
- Why: The claim row is the mutex; per-claim contention is tiny; NO KEY UPDATE conflicts with itself but not with FK `KEY SHARE`, so concurrent line inserts queue instead of deadlocking on lock upgrade.
- Rejected: `FOR UPDATE` (deadlocks with FK KEY SHARE); SERIALIZABLE everywhere (retry loops, generic errors); optimistic version columns across multi-row writes; advisory locks; unscoped locks (lets finance stall writers).

**D-27 Line-item save contract: one atomic PUT replace-set, child ids bound to their claim** — CORE · Doc 04 (UI Doc 05)
- Decision: The **only** line-item write path is `PUT /api/v1/claims/:claimId` `{ title, lineItems: [{ id?, expenseDate, categoryId, amountMinor, description, merchant? }] }` (0..50 lines). One transaction: lock owned claim → status check → `SELECT id FROM line_items WHERE claim_id = $claimId`; **any incoming `id` not in that set → 404 `LINE_ITEM_NOT_FOUND` before anything is written**; duplicate ids → 422 → category checks → `deleteMany({ claimId, id notIn kept })` → `updateMany({ where: { id, claimId } })` per kept row (expect count 1) → `createMany` new rows with `claimId` from the path → title update. `line_items.claim_id` is immutable (UC010). Every repository write signature is `(tx, actor, claimId, childId?)`. Receipt routes are claim-bound paths ([C-07](#c-07-api-routes)). Response is the fresh `ClaimDetail`.
- Why: One request = one transaction = one commit-time total verification, so a claim is never half-saved; binding every child id to the path claim (and the path claim to the owner) closes the IDOR where a foreign line id rides in my body.
- Rejected: per-line POST/PATCH/DELETE endpoints + header PATCH (double the surface); `update({ where: { id } })` (the IDOR); client-side diff with N calls.

**D-28 Validation** — CORE · Doc 04
- Decision: Shared Zod 4 schemas in `src/shared/schemas/*`, imported by route handlers and forms. Request schemas are **strict**: a total-like key (`totalMinor`, `total`, `total_minor`) → 422 `TOTAL_IS_DERIVED`; another server-owned key (`id` on the claim body, `status`, `claimantId`, `claimNumber`, `currency`, `currentRevision`, `submittedAt`, `approvedAt`, `rejectedAt`, `createdAt`, `updatedAt`, `allowedActions`, `approval`; on lines `claimId`, `receipts`) → 422 `READ_ONLY_FIELD`; anything else unknown → 422 `VALIDATION_FAILED` (`details.issues[].path`). Rules: `amountMinor` integer 1..100,000,000; `expenseDate` valid ISO `YYYY-MM-DD`, ≥ 2000-01-01 and ≤ today in Asia/Kolkata; `categoryId` uuid of an existing category (unknown → 422 `VALIDATION_FAILED` at the field path) that is active (→ 422 `CATEGORY_INACTIVE`); `description` trimmed 3..500; `merchant` ≤ 120; `title` trimmed 3..120; ≤ 50 lines; Σ lines ≤ 1,000,000,000 (422 `VALIDATION_FAILED` path `lineItems`); reject reason trimmed 10..1000; approve comment ≤ 1000; recall note ≤ 500. DB CHECKs/triggers repeat the rules as backstops.
- Why: Silently stripping a smuggled `totalMinor` would return 200 — the "silent no-op" §6 forbids; an explicit 422 is demonstrable evidence for §3.1.
- Rejected: Zod default strip mode; passthrough; decimal-string `amount` on the wire; 90-day expense-age rule (CUT, see D-51).

**D-09 Money** — CORE · Doc 03 (UI Doc 05)
- Decision: Integer paise everywhere: JSON safe integers on the wire (`amountMinor`, `totalMinor`), `number` in TS, `int4` in Postgres. Line 1..100,000,000 (₹10,00,000.00); claim total 0..1,000,000,000 (₹1 crore, CHECK). Client parses typed strings with `parseMoneyToMinor()` (string math, en-IN commas accepted) and formats by passing a decimal **string** to `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`. `<input inputMode="decimal">`, never `type=number`. Currency stored per claim, `'INR'` only in the POC (`claims.currency char(3) DEFAULT 'INR'`). Overflow fails closed (22003/23514 → 422).
- Why: `0.29 * 100 === 28.999999999999996`; integers can't drift, and decimals appear only when formatting.
- Rejected: floats/decimal.js/dinero; BigInt (JSON friction); `numeric` (Prisma Decimal objects); decimal-string wire format; env-configurable currency.

**D-10 Dates, instants and the business timezone** — CORE · Doc 03 (helpers Doc 06)
- Decision: `BUSINESS_TIMEZONE = 'Asia/Kolkata'` is a **code constant** in `src/shared/policy.ts` (and hard-coded in two SQL functions: the future-date check and `next_claim_number()`), not an env var. All instants `timestamptz(3)` (`@db.Timestamptz(3)`), UTC on the wire with `Z`; calendar dates `date` / `YYYY-MM-DD` strings end to end (no `Date` objects for expense dates). Date-range filters and export periods are inclusive IST calendar dates converted once to a half-open UTC range by `businessDayRangeToUtc(from, to)` in `src/shared/dates.ts`, implemented with `Intl` only. Display in IST with an "IST" label.
- Why: ms precision round-trips through JS `Date` (keyset cursors depend on it); finance reasons in IST calendar days; changing the books' timezone is a business change needing a migration.
- Rejected: `APP_TIMEZONE`/`BUSINESS_TIMEZONE` env vars; `timestamptz(6)`; browser-local display; date-fns-tz / date-picker libraries; hard-coded `+05:30` arithmetic.

**D-11 IDs and claim numbers** — CORE · Doc 03
- Decision: Every PK `uuid DEFAULT uuidv7()` generated by Postgres 18 (`@default(dbgenerated("uuidv7()")) @db.Uuid`). Human `claim_number` = `EXP-<IST year of creation>-<global sequence padded to ≥6>` (e.g. `EXP-2026-000123`) from `next_claim_number()` on `claim_number_seq` (`greatest(6, length)` padding), `CHECK (claim_number ~ '^EXP-[0-9]{4}-[0-9]{6,}$')`. Fallback if `prisma migrate dev` keeps reporting drift (it did not in P0): the service runs `SELECT public.next_claim_number()` inside the same `withTx` as the INSERT and passes the result, keeping the unique index and CHECK; never `nextval` plus JS formatting (after the BUG-1 fix `claims_guard` keeps only a number equal to this session's `currval` formatted with the IST year of `now()`, so anything else draws a second number). Gaps are fine.
- Why: Time-ordered keys keep B-trees compact and DB-side generation covers raw SQL and seeds; a sequence is lock-free and finance needs uniqueness, not gaplessness.
- Rejected: serial ints (enumerable); UUIDv4 (index churn); Prisma-side `uuid(7)` (only fallback if PG < 18); per-year counter table (hot lock).

**D-36 Function hardening** — CORE · Doc 03
- Decision: Every PL/pgSQL function schema-qualifies relations and types (`public.claims`, `public.claim_status`) and is declared `SET search_path = pg_catalog, public, pg_temp`. `REVOKE TEMPORARY ON DATABASE expense_claims FROM PUBLIC` and `REVOKE CREATE ON SCHEMA public FROM PUBLIC` run in `01-roles.sh`; the single Testcontainers DB is created by the same script, so tests have the same privileges as production. A schema test asserts every function pins `search_path` and every table has exactly its expected, enabled triggers.
- Why: `pg_temp` is searched first for relations; a temp table named `claims` could otherwise fool a trigger.
- Rejected: relying on the default `search_path`; template-cloned per-file test DBs (don't copy database-level privileges).

**D-37 Migrations and drift** — CORE · Doc 03
- Decision: `prisma migrate dev --create-only`, then hand-append SQL (functions, triggers, CHECKs, views, grants) to the generated migration; never edit an applied migration; never `db push`/`db pull`. Partial indexes declared in `schema.prisma` with the Prisma ≥ 7.4 `partialIndexes` preview feature (fallback: hand-written SQL + non-partial schema index). **Drift rule (one rule everywhere):** Drift = `pnpm db:deploy && pnpm db:diff-check` (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`); no shadow DB is needed or pre-created. P0 exit criteria: that check prints "No difference detected", and `prisma migrate dev --create-only` run twice yields empty migrations (both verified in P0). CI (P8) runs the same two commands. Migration list in [C-23](#c-23-migrations). Grants are explicit per table in the migration that creates the table — **no `ALTER DEFAULT PRIVILEGES` for DML**.
- Why: Objects Prisma doesn't model are replayed in the shadow DB so drift stays quiet; explicit grants mean a new table is never accidentally writable.
- Rejected: SQL applied outside migrations; default privileges (silent DML on future append-only tables).

**D-51 Scope guard: deepen, don't add** — CORE · PLAN
- Decision: CUT: 90-day maximum expense age; HEIC receipts; per-line endpoints; policy versioning; Entra code; claim `version` (OPTIONAL); admin UI. Every §6 item is CORE and listed in the never-cut list (PLAN).
- Why: §8 says "don't add new features — deepen what's here".

### Receipts

**D-30 Receipts: per line item, behind `ReceiptStorage`, server-proxied upload into an S3-compatible store** — CORE (signed URLs = OPTIONAL-§8) · Doc 06 (API Doc 04)
- Decision: Receipts attach **per line item** and are optional for submission. `POST /api/v1/claims/:claimId/line-items/:lineItemId/receipts` (`multipart/form-data`, single field `file`): reject `Content-Length` > 10 MiB + 64 KiB and files > 10,485,760 bytes (413 `PAYLOAD_TOO_LARGE`); content type ∈ {`image/jpeg`, `image/png`, `image/webp`, `application/pdf`} **and** magic bytes match (else 422 `RECEIPT_TYPE_NOT_ALLOWED`); compute sha256; pre-check (owner claim visible, line belongs to claim, editable, < 5 receipts on the line → else 404/409/422 `RECEIPT_LIMIT_REACHED`); `storage.put()` to a fresh key `receipts/{claimId}/{lineItemId}/{randomUUID}`; then `withTx`: lock owned claim, re-check, insert the `receipts` row (with sha256); if the transaction fails, best-effort `storage.delete(key)`. Downloads stream through the app after the visibility check (`GET …/receipts/:receiptId/content`, stored Content-Type, `Content-Disposition: attachment`, `nosniff`, `no-store`); the route also serves receipts referenced only by an older revision's snapshot. Interface `ReceiptStorage { put, get, delete, ping }` with `S3ReceiptStorage` (AWS SDK v3, internal endpoint `S3_ENDPOINT`, `forcePathStyle: true`, region `us-east-1`, `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`), `MemoryReceiptStorage` (tests), `FsReceiptStorage` (fallback) chosen by `RECEIPT_STORAGE_DRIVER`. Local store: SeaweedFS 4.48 `weed mini`; the bucket is ensured by the migrate job. Fallback ladder decided at the **P6 storage gate** ([PLAN §5](../../PLAN.md#decision-gates); 30-min timebox, which also absorbs the old P0 object-store probe): SeaweedFS → FS-volume adapter (full recipe in [01 §11.3](./01-architecture-and-stack.md#113-developer-flows): app volume, `uid 1000`-owned `.data/receipts`, no-op `ensure_bucket`, `objectstore` removed or moved under a profile). DB trigger `receipts_before_write` locks the parent claim and enforces editability (UC001/UC002); composite FK `(line_item_id, claim_id) → line_items(id, claim_id)`.
- Why: A receipt proves a specific expense, §3.4 must lock attachments so they are core, and the server-proxied path keeps the integrity story simple: no client ever holds a write credential, so approved evidence can't be overwritten.
- Rejected: per-claim receipts (can't tell which line lacks evidence); local disk as the primary store (§8 says object store); presigned PUT (no size cap); MinIO (archived, images gone); LocalStack (auth token); storing files in Postgres.
- OPTIONAL-§8: presigned POST upload to quarantine key `pending/{receiptId}` (`content-length-range`, exact Content-Type, TTL ≤ 120 s) → confirm (lock + status check first, then HEAD + magic bytes + sha256, then CopyObject to the final key) → `receipt_status` PENDING/UPLOADED, `S3_PUBLIC_ENDPOINT` signer client, bucket CORS, sweeper; presigned GET (60 s) download. Scoped non-admin S3 identity for the app.

**D-31 Receipt retention** — CORE · Doc 06
- Decision: Storage objects are deleted **only** for claims that were never submitted (`current_revision = 0`): after commit on receipt delete, on line delete via PUT, and on draft delete. For any claim with `current_revision > 0`, deleting a receipt row or line keeps the object, because a submission snapshot may reference it. No sweeper in core (orphans from a crash between `put` and a failed insert are harmless and listed in the runbook).
- Why: Evidence finance needs in a dispute (revision-1 receipts) can never be garbage-collected, with zero extra tables.
- Rejected: post-commit delete always + sweeper deleting "unreferenced" objects (destroys snapshot evidence); `retained_objects` ledger table (correct, more moving parts).

### Lists and export

**D-29 Lists: keyset pagination and filters in SQL** — CORE · Doc 04 (indexes Doc 03)
- Decision: Three persona endpoints, each with its own repository function whose actor scope is a non-optional WHERE: `GET /api/v1/claims` (mine), `GET /api/v1/approvals` (my steps), `GET /api/v1/finance/claims` (FINANCE). Keyset on `(sortValue, id)` with `LIMIT n+1`; opaque base64url cursor; strict query schemas (unknown param → 422); fixed sort per endpoint (sort allowlists OPTIONAL); no `COUNT(*)`. Params and sorts in [C-09](#c-09-pagination-and-filter-parameters). Every hot query is an index range scan with no Sort (EXPLAIN evidence in P7).
- Why: §6: filtering never loads every claim; keyset is O(page) and stable under concurrent inserts; a route-fixed scope can't be widened by a client flag.
- Rejected: OFFSET; Prisma `cursor + skip:1`; one polymorphic `/claims?scope=`; HMAC-signed cursors (a cursor is a position, not a permission).

**D-32 Finance export semantics, streaming and consistency** — CORE (RR snapshot + `export_runs` = OPTIONAL) · Doc 06
- Decision: `GET /api/v1/finance/exports/approved-claims?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=APPROVED]` → `text/csv`; FINANCE only (ADMIN excluded). `from`/`to` required, inclusive IST dates, span ≤ 366 days (422 `EXPORT_RANGE_TOO_LARGE`), `from > to` → 422 `VALIDATION_FAILED`; `status` accepts only `APPROVED` (anything else → 422 `EXPORT_STATUS_NOT_ALLOWED`, message cites §3.6) — this is how the export "supports status filtering" (§6) without ever leaking in-flight or rejected claims. Period = `approved_at ∈ [from 00:00 IST, (to+1) 00:00 IST)` **and** `approved_at < asOf` where `asOf = SELECT clock_timestamp()` at request start; predicate also has `status = 'APPROVED'`. Rows: one per line item, read from the **approved submission's snapshot** (`claims.current_submission_id`), joined to the final approver. Streaming: a pull-based `ReadableStream`; each `pull()` runs one keyset batch of `EXPORT_BATCH_SIZE` (500) claims on `(approved_at, id)` under READ COMMITTED (no long transaction) and enqueues CSV; any error calls `controller.error()` so the download fails visibly instead of looking complete. Headers: `Content-Disposition: attachment; filename="approved-claims_<from>_<to>.csv"`, `X-Export-As-Of`, `X-Export-Period-Open: true` when `(to+1) 00:00 IST + 2 minutes > asOf` (settle window ≫ 10 s transaction timeout). Log `export.started` / `export.completed` / `export.failed` with counts.
- Why: Approved claims are terminal and immutable with DB-stamped `approved_at`, and rows come from the frozen snapshot, so a closed period's export is stable; memory is bounded by batch size, never by period length.
- Rejected: building the CSV in memory; OFFSET batches; filtering by expense date (late approvals would rewrite closed months); POST + async job (overkill); live joins to categories/users (reference edits would change past exports); a dotted `.csv` path segment (routing risk; the filename is in Content-Disposition).
- OPTIONAL (first SHOULD in the buffer): one REPEATABLE READ READ ONLY transaction for all batches, `export_runs` (RUNNING → SUCCEEDED/FAILED with counts, total, sha256; terminal rows immutable), `EXPORT_MAX_CONCURRENT` semaphore (429), summary endpoint.

**D-33 CSV layout and injection safety** — CORE · Doc 06
- Decision: Columns in [C-22](#c-22-csv-export-columns). RFC 4180 quoting, CRLF, UTF-8 with BOM. Own `src/server/export/csv.ts` (~30 lines): every text column we don't generate is passed through `csvText()`, which strips leading whitespace for the test and prefixes `'` when the value starts with `= + - @`, TAB or CR. Generated columns (amounts, ISO dates, uuids, claim numbers, GL codes with a CHECK regex) are written raw.
- Why: The file opens in Excel safely and imports without rekeying; one row per line keeps GL-level posting.
- Rejected: one row per claim (loses GL split); XLSX; locale-formatted numbers; `csv-stringify` (stream API mismatch with web streams; we need custom escaping anyway); a totals trailer row (breaks importers).

**D-48 Load-test and query-plan evidence** — CORE-light (P7) + OPTIONAL-§8 · Doc 07
- Decision: CORE-light: `scripts/perf/seed-perf.ts` runs set-based SQL as the owner into a separate database `expense_perf` (`PERF_DATABASE_URL`, a core variable in C-11) with **all triggers on** (default `--months 24 --claims 10000`, ~4 lines each, realistic status mix incl. full approvals with snapshots, steps and events; the one generator spec is [07 §12.1](./07-testing.md#121-the-generator-scriptsperfseed-perfts-pnpm-perfseed)), then `ANALYZE` and a drift check; `scripts/perf/explain.ts` captures `EXPLAIN (ANALYZE, BUFFERS)` of one export batch, one approver-queue page and one finance-list page, before and after (index dropped inside `BEGIN … ROLLBACK`), into `docs/perf/*.txt`. OPTIONAL-§8 (O3): `--claims 50000` / `100000`, k6 2.3 (`load/export.k6.js`, compose profile `load`) with p95 thresholds and RSS measurement, `tests/perf/plans.perf.test.ts` plan assertions.
- Why: The cheapest proof of §6 "not loading every claim into memory" and a head start on §8.
- Rejected: disabling triggers for fast loading (proves nothing); loading into the demo DB; autocannon.

### Operations

**D-34 Database roles and credential separation** — CORE · Doc 03 (compose Doc 01)
- Decision: Three roles, fixed names (triggers reference `'expense_app'`): `postgres` superuser (used only by the postgres container's initdb), `expense_owner` (owns database + schema + all objects; NOSUPERUSER NOCREATEROLE NOBYPASSRLS; CREATEDB for the local Prisma shadow DB; used **only** by the `migrate` job and host-side `prisma` CLI), `expense_app` (runtime; LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; owns nothing; DML per [C-16](#c-16-privilege-matrix-expense_app); role settings `statement_timeout 15s`, `lock_timeout 5s`, `idle_in_transaction_session_timeout 30s`). **The app container never receives owner or superuser credentials:** one `.env` file is used only for compose interpolation and host commands; no service uses `env_file`; each service gets an explicit `environment:` list ([C-11](#c-11-environment-variables)); the app's `DATABASE_URL` is composed from `DB_APP_PASSWORD`. Boot self-check in `instrumentation.ts` `register()`: (1) when `NODE_ENV=production`, `process.exit(1)` if any of `MIGRATE_DATABASE_URL`, `SHADOW_DATABASE_URL`, `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `SEED_DEMO_PASSWORD` is set; (2) always, `assertRuntimeRole()` (via `src/server/db/introspection.ts`) exits if the connected role is superuser, BYPASSRLS, CREATEROLE, CREATEDB, owns any relation in `public`, or is a member of `expense_owner` (verified in P0: with owner credentials the app exits 1); from P3 the tier-policy check (D-19) runs after them. All published ports bind to `127.0.0.1`. (Consequence, by design: `pnpm start` on the host refuses to boot while the host `.env` holds owner variables — production-mode runs go through compose; `pnpm dev` is unaffected.)
- Why: The app's own connection can't `DISABLE TRIGGER`, `TRUNCATE`, `SET session_replication_role`, alter schema or rewrite history — that is what makes "provably impossible" true even against raw SQL from a compromised app process.
- Rejected: connecting as the image superuser; `env_file: .env` on the app service (hands it the owner URL and superuser password); separate `.env.db/.env.migrate/.env.app` files (violates "only a documented `.env`"; per-service `environment:` achieves the same isolation).

**D-35 Least-privilege grants** — CORE · Doc 03
- Decision: Matrix in [C-16](#c-16-privilege-matrix-expense_app). `expense_app` has SELECT only on `users`, `departments`, `categories`, `approval_policy_tiers`; SELECT+INSERT only on `claim_submissions` and `claim_events`; no DELETE on `approval_steps`; no UPDATE on `receipts`; nothing on `_prisma_migrations`; no TRUNCATE/TRIGGER/REFERENCES anywhere. The privilege test iterates **every** table in `public` and fails on any table missing from the expected matrix.
- Why: No SQLi, bug or compromised dependency running as the app can self-grant FINANCE, re-point a manager, collapse the tier policy or rewrite history.
- Rejected: DML on identity/reference tables "for the seed" (the seed runs as owner).

**D-38 Docker and compose topology** — CORE · Doc 01
- Decision: Multi-stage Dockerfile `base → deps → build → runner | tools` on `node:24.21.0-trixie-slim` (digest-pinned, C-12; the build stage runs `mkdir -p public` because git doesn't track an empty `public/`). `runner`: Next standalone `server.js`, non-root `node` (uid 1000), `HOSTNAME=0.0.0.0`, Node-fetch `HEALTHCHECK` on `/api/health/ready`, no CLI/devDeps/source/.env. `tools`: one-shot jobs, entrypoint subcommands `migrate | seed | ensure-bucket | release` (`release` = migrate deploy → ensure-bucket (from P6; before the seed from P8) → `seedReference()` always → cast + demo claims if `SEED_ON_START=true` and `users` is empty (D-45)). Compose services **`postgres`, `objectstore`, `migrate`, `app`** (+ `k6` under profile `load`, OPTIONAL). Boot order via `depends_on` conditions: `postgres` and `objectstore` healthy → `migrate` `service_completed_successfully` → `app`. `app`: `init: true`, `stop_grace_period: 20s` (Next standalone handles SIGTERM; `NEXT_MANUAL_SIG_HANDLE` not set). `docker compose down -v && cp .env.example .env && docker compose up --build --wait` is the only setup. Names in [C-17](#c-17-docker-and-compose-names).
- Why: Migrating is a release step (maps to an Azure Container Apps Job), the runtime image holds no DDL rights, and boot order is deterministic without sleep scripts.
- Rejected: migrations in the app entrypoint; Alpine images; a separate `storage-init` service; `read_only`/`cap_drop` hardening (OPTIONAL — can break Next cache dirs).

**D-39 Environment configuration** — CORE · Doc 01
- Decision: Lazy, memoized, Zod-validated `env()` in `src/server/env.ts`, called fail-fast from `instrumentation.ts` (`process.exit(1)` on invalid config); the image builds with zero env. `APP_ENV` (`local | test | staging | production`) is separate from `NODE_ENV`. No `NEXT_PUBLIC_*` variables. Refinement: when `APP_ENV ∈ {staging, production}` require `SEED_ON_START=false`, `DEMO_MODE=false`, `SEED_DEMO_PASSWORD` absent, `APP_BASE_URL` https. `cp .env.example .env` is the only manual step. Full list in [C-11](#c-11-environment-variables).
- Why: `next build` evaluates route modules, so env must be lazy; a misconfigured server must refuse to start; the same image runs everywhere.
- Rejected: top-level env parsing; `@t3-oss/env-nextjs`; `AUTH_SECRET`; `APP_TIMEZONE`; `APP_CURRENCY`; `DATABASE_URL_MIGRATE` / `DATABASE_OWNER_URL` / `APP_URL` spellings.

**D-40 Structured logging and request ids** — CORE (OTel OPTIONAL) · Doc 06
- Decision: pino 10.4 JSON to stdout, no transports (pretty only via `| pino-pretty` in dev), ISO time, label levels, base `{service: 'expense-claims', env, version}`, a mixin reading AsyncLocalStorage `{requestId, userId, route}`, redaction of `cookie`, `set-cookie`, `authorization`, `password`, `token`, `*.passwordHash`. `x-request-id` accepted if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise replaced with `crypto.randomUUID()`; echoed on every response, included in every error envelope and stored in `claim_events.request_id varchar(64)`. One access log per request (`http.request`, health at debug). Domain logs after commit (names in [C-19](#c-19-log-event-names)). A DB-backstop error surfacing through the API is logged at `error` with `defense: 'db'` and `sqlstate`.
- Why: Every line in a request is correlated without passing loggers around, and `request_id` joins the audit row to the logs in a dispute; logs are operational, `claim_events` is evidence.
- Rejected: `console.log`; in-process pino transports (worker threads break under Next bundling); request id only in proxy (no shared async context with handlers); logs as audit. OPTIONAL: OpenTelemetry (`@vercel/otel`, Jaeger compose profile).

**D-41 Health, readiness and shutdown** — CORE · Doc 06
- Decision: `GET /api/health/live` (process up, no dependencies) and `GET /api/health/ready` (`SELECT 1` with a 1 s timeout **and** zero disabled non-internal triggers in `public`; storage `ping()` reported as `ok | degraded` but never failing readiness) → 200 `{data:{status:'ready', checks:{db, integrityTriggers, storage}}}` or 503 `NOT_READY`. Both public, outside `/api/v1`, in `PUBLIC_ROUTES`, no business data. Graceful shutdown verified with `docker compose stop app` in P8 (an in-flight export ends as a failed download).
- Why: Orchestrators need unauthenticated probes; a disabled integrity trigger takes the instance out of rotation; a storage blip shouldn't.
- Rejected: one `/health` that restarts the app on a DB blip; authenticated probes; `/api/v1/health/*` and `/api/ready` spellings.

**D-45 Seed strategy and the demo cast** — CORE · Doc 03 (cast) / Doc 07 (fixtures)
- Decision: One cast for seed, Vitest factories, Playwright and README ([C-15](#c-15-demo-seed-accounts)). `prisma/seed.ts` runs in the migrate job **as the owner** (`DATABASE_URL` set to the owner URL in that process only) in **two parts**. (1) `seedReference()` runs on **every** `release`, regardless of `SEED_ON_START` and in every environment: departments, 10 active + 1 inactive categories, tiers T1–T3 active (from P3, when the table exists), and T4 `L4_CFO` inactive only if its designated user deepa exists; every insert is `INSERT … ON CONFLICT (code) DO NOTHING`, so an activated L4 is never reset and an existing dev volume picks up new reference rows. (2) The cast and demo claims C01–C12 run through the real services with a `SeedClock` ([C-26](#c-26-repository-and-service-signatures)) for backdated history, only when `SEED_ON_START=true` and `users` is empty; this part refuses to run when `APP_ENV ∈ {staging, production}` or any email doesn't end in `.test`. Password = `SEED_DEMO_PASSWORD` from `.env` (obviously-demo value only in `.env.example`). After extending the seed in P3–P5, `docker compose down -v && docker compose up --build --wait` must still be healthy.
- Why: Seeded data obeys the same integrity rules as production; one cast stops five naming schemes drifting; reference data on every release means the boot-time tier check (D-19) can pass in staging/production and on an already-seeded dev volume.
- Rejected: raw inserts with triggers disabled; five per-section casts; seeding as `expense_app` with backdatable timestamps.

**D-49 CI and supply chain** — CORE (minimal) · Doc 01
- Decision: One GitHub Actions workflow, scheduled in P8 (until then `pnpm verify` is the local gate; cut item 6 if behind): install (frozen lockfile) → `prisma generate` → typecheck → lint → format check → unit → component → integration (Testcontainers) → drift (`pnpm db:deploy && pnpm db:diff-check` on the compose Postgres, D-37). Exact pins, committed lockfile, `onlyBuiltDependencies` (`@prisma/engines`, `prisma`, `esbuild`, `unrs-resolver`; confirmed in P0). OPTIONAL: e2e in CI, SHA-pinned actions, Dependabot with cooldown, Trivy, husky/lint-staged, `minimumReleaseAge`. NOT PLANNED: GHCR publish, SBOM.
- Why: A cheap regression net; CI/CD depth is 201-path material.

### Testing

**D-42 Test-DB strategy: one Testcontainers Postgres, serial files, app-role connections** — CORE · Doc 07
- Decision: Vitest `globalSetup` (`tests/helpers/global-setup.ts`) starts **one** `postgres:18.6-trixie` container per run (same digest as compose, C-12) via `@testcontainers/postgresql` 12.2.0 with `docker/postgres/initdb/01-roles.sh` mounted (same roles, same REVOKEs), runs `prisma migrate deploy` as `expense_owner`, seeds reference data and the cast as owner, and exposes app/owner URLs. External-DB mode: when `TEST_PG_SUPERUSER_URL` is set, it uses that empty PG 18 cluster instead (fresh `expense_claims_test_<hex>` database, the same `01-roles.sh` SQL); Testcontainers stays the default. App code under test connects as **`expense_app`**. `beforeEach`: as owner, one TRUNCATE over the transactional tables **that exist** (`claims, line_items, receipts, claim_submissions, approval_steps, claim_events, sessions, export_runs` filtered through `pg_tables`, so the helper works from P0 although `receipts` arrives in P6) and delete throwaway users (`email LIKE 'tmp.%'`). `afterEach(assertTotalsInSync)`: `v_claim_total_drift` must be empty after **every** integration test. `fileParallelism: false`. Raw-SQL attack tests use `appSql` / `ownerSql` pg clients (`tests/helpers/db.ts`).
- Why: Only a real PG 18 proves triggers, deferred checks, locks and grants; running as the app role proves what the production credentials can and cannot do; the invariant hook turns every test into a desync probe.
- Rejected: compose `db-test` profile (second harness; CUT); per-file template DBs + parallel forks (OPTIONAL; template clones drop DB-level REVOKEs); transaction-rollback-per-test (deferred checks fire only at COMMIT); SQLite/pg-mem; mocking Prisma.

**D-43 Route-testing approach** — CORE · Doc 07
- Decision: Integration tests import route modules and call `GET/POST/PUT/DELETE` in-process with a real `NextRequest` via `callRoute(mod, method, { path, params, query, body, as, headers })` (`tests/helpers/http.ts`). Auth reads only the request cookie; `as: persona` creates a session row with `createSession(userId)` (`tests/helpers/auth.ts`, **not** exported from `src`). `server-only` is aliased to an empty module in Vitest. Vitest projects: `unit` (`tests/unit/**/*.test.ts`), `integration` (`tests/integration/**/*.int.test.ts`), `component` (`tests/component/**/*.test.tsx`, jsdom, `TZ=America/Los_Angeles`). Real HTTP is covered once by Playwright.
- Why: 10–50× faster than HTTP, in-process stack traces, and still the full `defineRoute → service → repository → triggers` path.
- Rejected: HTTP against a running server for all integration tests; unit-testing services with mocked Prisma.

**D-44 E2E strategy** — CORE (journey 1 + foreign-claim + page redirects TC-E04 + stack smoke), others CORE-if-on-time · Doc 07
- Decision: Playwright 1.63 on the host against the production image under `docker compose up --wait` (`E2E_BASE_URL`), `workers: 1`, browser `timezoneId: 'America/Los_Angeles'`, `storageState` per persona created via the login API in `auth.setup.ts`; specs create uniquely titled claims and never reset the DB. Spec list in the traceability test catalogue.
- Why: Proves the real image, migrate job, object store and cookies; a non-IST browser proves IST formatting is timezone-independent.
- Rejected: Cypress; e2e against `next dev`; logging in through the UI in every test.

**D-47 Observability extras** — OPTIONAL · Doc 06
- Decision: OpenTelemetry tracing (`@vercel/otel`, `@prisma/instrumentation`, Jaeger profile) only in the buffer.

**D-52 Documentation set** — CORE · PLAN
- Decision: `PLAN.md` + the seven `docs/design/0N-*.md` docs (this planning step), and during the build: README with a §6 table (bullet → enforcement point → exact test name), eight one-page ADRs — 0001 single Next app & REST-only, 0002 layering & import boundaries, 0003 claim-total integrity, 0004 lifecycle/revisions/amount-change rule, 0005 data-driven routing, 0006 authz/404-vs-403/scoped queries, 0007 sessions vs JWT & Entra mapping, 0008 DB roles & migrations as a job — plus `docs/walkthrough.md`, `docs/demo-script.md`, `docs/runbook.md` (stuck steps, orphans) and `scripts/demo/*.sh`.
- Why: One ADR per likely RM question; the README §6 table is what reviewers read.

---

## B. Resolution log

| # | Topic | Conflicting variants | Resolution (canonical) |
|---|---|---|---|
| R-01 | DB error convention | data UC001–UC018; security EC001–EC006; delivery `EC409`+HINT; workflow `P0001` message tokens | One custom class **UC**, MESSAGE prefixed `<API_CODE>: …`, mapped **by SQLSTATE only** via `readSqlState()` ([C-05](#c-05-sqlstate--api-mapping)). Numbering re-issued (UC001–UC017) |
| R-02 | Step status for not-yet-active steps | WAITING (data, workflow, frontend) vs QUEUED (security) | **WAITING** |
| R-03 | Roles model | `users.role` + `can_approve` (data); `user_roles` table (security); `roles[]` (workflow, delivery) | `users.role` {EMPLOYEE, FINANCE, ADMIN} + `can_approve` + `is_fallback_approver`, row CHECKs (D-08) |
| R-04 | Audit writer | SECURITY DEFINER triggers + GUCs (data) vs service `auditRepo.append` (workflow, delivery, security) | **Service `recordEvent(tx)` only**, app has SELECT+INSERT, append-only trigger, deferred `assert_transition_audited` (D-22). GUCs and audit triggers CUT |
| R-05 | Submission snapshot builder / mutability | DB-built + REVOKE UPDATE (data) vs service-built + `submissionRepo.close()` UPDATE of outcome (workflow) | Service-built, **DB-verified** (incl. exact line-set equality), INSERT-only; outcome derived by pure function (D-18) |
| R-06 | Routing policy model | `min/max_total_minor` + `approval_levels` + UC015/UC017 (data) vs versioned `approval_policies` + threshold tiers + resolver kinds (workflow) | Single `approval_policy_tiers` table, exclusive `applies_above_minor`, per-tier `resolver`, no versioning (D-19) |
| R-07 | Lock mode | `FOR NO KEY UPDATE` (data) vs `FOR UPDATE` (workflow, security) | **FOR NO KEY UPDATE** everywhere (D-14) |
| R-08 | Approver lock/visibility predicate | `activated_at IS NOT NULL` (workflow; includes CANCELLED) vs `status IN (PENDING, APPROVED, REJECTED)` (security) | Lock: PENDING-only; visibility: PENDING/APPROVED/REJECTED (D-14, D-26) |
| R-09 | Approve-action diagnosis | 6-branch tree with `STALE_REVISION`/`CLAIM_RECALLED`/`STEP_ALREADY_DECIDED` (workflow) vs 403 on double approve (delivery) | No PENDING step: 409 `ALREADY_DECIDED` if I decided the current revision, else 403 `NOT_IN_YOUR_QUEUE`; revision mismatch 409 `REVISION_MISMATCH` |
| R-10 | Route wrapper name | `defineRoute` / `authed()+publicRoute()` / `withApi()` | **`defineRoute`** + `ROUTE_META` (D-07) |
| R-11 | Approve route | `/approvals/[id]/approve` vs `/claims/:id/approve` | **`POST /api/v1/claims/:claimId/approve`** (and `/reject`) |
| R-12 | Queue path | `/approvals` vs `/approvals/queue` | **`GET /api/v1/approvals`** |
| R-13 | Health paths | `/api/health/live|ready` vs `/api/v1/health/*` vs `/api/health` + `/api/ready` | **`/api/health/live`, `/api/health/ready`** |
| R-14 | Money on the wire | decimal string `amount` (security) vs integer `amountMinor` (data, frontend) | **Integer `amountMinor`**; client parses strings (D-09) |
| R-15 | Money DB type | int4 (data) vs BIGINT (workflow, delivery) | **int4**; only optional `export_runs.total_minor` is bigint |
| R-16 | Timestamp precision | `timestamptz(3)` vs `(6)` | **`timestamptz(3)`** |
| R-17 | ID generation | DB `uuidv7()` vs Prisma `uuid(7)` | **DB `uuidv7()`**; Prisma `uuid(7)` only if PG < 18 |
| R-18 | Timezone config | `APP_TIMEZONE` env / `BUSINESS_TIMEZONE` env / code constant | **Code constant** `BUSINESS_TIMEZONE` (D-10) |
| R-19 | Currency config | `APP_CURRENCY` / `DEFAULT_CURRENCY` / `CURRENCY` env | **No env**; `'INR'` constant + per-claim column |
| R-20 | Owner DB URL env name | `MIGRATE_DATABASE_URL` / `DATABASE_URL_MIGRATE` / `DATABASE_OWNER_URL` | **`MIGRATE_DATABASE_URL`** |
| R-21 | Base URL env name | `APP_BASE_URL` / `APP_URL` / `APP_ORIGIN` | **`APP_BASE_URL`** |
| R-22 | Seed casts | five casts (Vikram/Priya…, anita/dev…, asha.claimant@example.test…, asha.rao@acme.test…, omar@acme.test) | **One cast** `@acme.test` ([C-15](#c-15-demo-seed-accounts)) |
| R-23 | Session model | signed tokens + `AUTH_SECRET` + `issueSessionToken` (stack, delivery) vs opaque DB sessions (security) | **Opaque DB sessions**; no `AUTH_SECRET`; test helper `createSession()` (D-05) |
| R-24 | Cookie name | `ec_session` checked by proxy vs `__Host-ec_session` set on https | One `sessionCookieName(appBaseUrl)` used by auth, cookie writer and `proxy.ts` |
| R-25 | Login response | 204 (frontend) vs 200 `{data}` (security) | **200 `{data:{user}}`** + Set-Cookie |
| R-26 | Test harness | Testcontainers + per-file template DBs (stack) vs compose `db-test` + TRUNCATE (data, delivery) | **Testcontainers, one container, serial, TRUNCATE** (D-42) |
| R-27 | Line-item write API | per-line POST/PATCH/DELETE + header PATCH (security) vs atomic PUT replace-set (frontend) | **PUT replace-set only** (D-27) |
| R-28 | RSC data reads | via actor-scoped services (stack D3, delivery) vs none (frontend) | **None**; services self-guard anyway (D-04) |
| R-29 | Receipt upload mechanism | presigned PUT (stack) / presigned POST to final key (security) / presigned POST to quarantine + confirm (delivery) / server-proxied (pragmatism) | **Server-proxied multipart** in core; quarantine POST flow is the §8 design (D-30) |
| R-30 | Receipt table name & status | `attachments` + PENDING/UPLOADED (data) vs `receipts` + PENDING/ATTACHED (delivery) vs AVAILABLE (frontend) | **`receipts`**, no status column in core; §8 adds `receipt_status` {PENDING, UPLOADED} |
| R-31 | Receipt route addressing | `/receipts/:receiptId/...` (delivery, frontend) vs claim-scoped | **Claim-bound**: `/claims/:claimId/receipts/:receiptId[/content]` |
| R-32 | Receipt download | 302 to presigned GET vs stream through app | **Stream through the app** (core); presigned GET is §8 |
| R-33 | Receipt types | +HEIC (data, delivery) vs jpeg/png/pdf (frontend) | **jpeg, png, webp, pdf**; ≤ 10 MiB; ≤ 5 per line |
| R-34 | Object store | SeaweedFS (stack, delivery) vs MinIO assumption (frontend) | **SeaweedFS 4.48**; fallback FS adapter (not RustFS) |
| R-35 | Receipt GC | never delete snapshot-referenced objects (data) vs post-commit delete + sweeper (delivery) | Delete objects only for never-submitted claims; no sweeper in core (D-31) |
| R-36 | Export consistency | RR READ ONLY tx + `export_runs` + semaphore (delivery) vs RC keyset batches (pragmatism) | **RC batches + `asOf` cap + snapshot rows + settle-window flag**; RR/`export_runs` OPTIONAL (D-32) |
| R-37 | Export path | `/approved-claims.csv` (delivery, frontend) vs `/approved-claims` | **`/api/v1/finance/exports/approved-claims`** (filename in Content-Disposition) |
| R-38 | Export status filter | none / hard-wired (security, delivery) vs `status` accepting only APPROVED (pragmatism) | **`status` param, APPROVED only, else 422 `EXPORT_STATUS_NOT_ALLOWED`** |
| R-39 | Export row source | live joins to categories/users (delivery) vs frozen snapshot (red-team) | **Approved submission snapshot** |
| R-40 | Export streaming primitive | TransformStream writer (delivery) vs pull-based ReadableStream | **Pull-based `ReadableStream`** (backpressure is natural) |
| R-41 | CSV library | `csv-stringify` (stack) vs own `csvText()` (delivery) | **Own `csv.ts`** |
| R-42 | Finance draft visibility | all incl. drafts (security) vs never (delivery, red-team) vs default-hidden (pragmatism) | **Visible, read-only; finance list excludes DRAFT unless `status=DRAFT`** |
| R-43 | Finance approve/reject response | `FINANCE_CANNOT_APPROVE` / `FORBIDDEN_ROLE` / `NOT_IN_YOUR_QUEUE` | **403 `FORBIDDEN`** (role gate, before any query) |
| R-44 | Non-owner write response | 403 `NOT_CLAIM_OWNER` (security) vs 404 (workflow, delivery) | **404 `CLAIM_NOT_FOUND`** (owner-scoped lock query) |
| R-45 | Revision pin field and code | `revision` / `expectedRevision`; `STALE_REVISION` / `REVISION_MISMATCH` / `CLAIM_REVISION_CHANGED` | **`revision`**, 409 **`REVISION_MISMATCH`** |
| R-46 | Editing a SUBMITTED claim | `CLAIM_IN_APPROVAL` vs `CLAIM_NOT_EDITABLE` | **409 `CLAIM_NOT_EDITABLE`** + `details.hint = 'RECALL_TO_EDIT'` |
| R-47 | Other code synonyms | `INVALID_STATE_TRANSITION`/`INVALID_STATUS_TRANSITION`; `STEP_ALREADY_DECIDED`/`ALREADY_DECIDED`; `CONCURRENT_UPDATE`/`CONCURRENT_MODIFICATION`; `ROUTING_UNRESOLVABLE` 422 vs `APPROVER_UNRESOLVED` 409 vs `ROUTING_UNRESOLVED`; `TOTAL_IS_DERIVED`/`TOTAL_READ_ONLY`; `FORBIDDEN`/`FORBIDDEN_ROLE`; `RECEIPT_*`/`ATTACHMENT_*` | `INVALID_STATUS_TRANSITION`, `ALREADY_DECIDED`, `CONFLICT`, `ROUTING_UNRESOLVABLE` (422), `TOTAL_IS_DERIVED`, `FORBIDDEN`, `RECEIPT_*` ([C-06](#c-06-error-code-catalogue)) |
| R-48 | Reject reason length | 5–1000 (data, workflow) vs 10–1000 (security, frontend) | **10–1000 trimmed** (Zod + DB CHECK) |
| R-49 | Max lines per claim | 50 (data, frontend) vs 100 (security) | **50** |
| R-50 | Expense date rule | 90-day window (data, security) vs ≤ today only (frontend) | **Valid ISO date, ≥ 2000-01-01, ≤ today IST**; 90-day rule CUT |
| R-51 | Claim `version` / optimistic concurrency | required on PUT/submit/recall (frontend) vs none | **OPTIONAL**; last-write-wins documented |
| R-52 | Transition timestamps | injected `Clock` (data, pragmatism) vs `clock_timestamp()` in service (workflow) vs DB-stamped (red-team) | **DB-stamped `now()` for `expense_app`**; owner-run seed may supply (D-23) |
| R-53 | Pagination defaults/envelope | limit 20 vs 25; `{nextCursor}` vs `{limit, hasMore, nextCursor}` + `meta` | **limit 1..100 default 25; `{data, page:{nextCursor, limit}}`** |
| R-54 | Request-id length | ≤ 128 (delivery) vs `{8,64}` (stack) vs `varchar(64)` column | **`^[A-Za-z0-9-]{8,64}$`** |
| R-55 | Postgres image | `postgres:18-alpine` (data, delivery) vs `18.6-trixie` (stack) | **`postgres:18.6-trixie`** |
| R-56 | Compose service names | `db`/`postgres`, `db-migrate`/`migrate`, `storage-init`, `db-test` | **`postgres`, `objectstore`, `migrate`, `app`** (+`k6` profile `load`) |
| R-57 | Database name | `expense` / `expense_test` vs `expense_claims` | **`expense_claims`** (+ `expense_perf` for the perf seed) |
| R-58 | Partial indexes | hand SQL (data) vs Prisma `partialIndexes` preview (delivery) | **Preview feature**; hand SQL is the fallback |
| R-59 | Approver queue amount | `approval_steps.amount_minor` column + amount index (delivery) vs join | **Join `claim_submissions.total_minor`**; no amount sort |
| R-60 | Step order column | `sequence` / `step_no` / `stepNo` | **`level`** (`approval_steps.level`, DTO `level`) |
| R-61 | User display name | `name` vs `display_name` | **`name`** |
| R-62 | Claim number DTO field | `number` (frontend) vs `claimNumber` | **`claimNumber`** |
| R-63 | Event types | data 6 types (incl. `STEP_REJECTED`); workflow 7 (incl. `CLAIM_RESUBMITTED`, `STEP_REASSIGNED`); frontend adds `CLAIM_CREATED`, `CLAIM_UPDATED`, `RECEIPT_*` | **6 types**: `CLAIM_SUBMITTED`, `CLAIM_RESUBMITTED`, `STEP_APPROVED`, `CLAIM_APPROVED`, `CLAIM_REJECTED`, `CLAIM_RECALLED` ([C-20](#c-20-audit-event-catalogue)) |
| R-64 | Who builds the approval chain shape check | `v_steps BETWEEN 1 AND required` (data) | **`count = applicable active tiers`** (D-21) |
| R-65 | ADR count | 14 (stack) / 16 (delivery) | **8 ADRs** (D-52) |
| R-66 | Admin capabilities | `/admin/policies` page (stack) vs no UI (frontend) | **No admin UI**; owner scripts/migrations only |
| R-67 | Dates/money helper location | `src/lib/validation` + `src/lib/money.ts` (stack) vs `src/shared/*` (frontend) | **`src/shared/*`** |
| R-68 | Prisma `forbidDerivedWrites` extension | core (data) vs redundant (pragmatism, red-team: breaks other models) | **OPTIONAL / not built** |
| R-69 | Date libraries | date-fns 4.4 + date-fns-tz (stack, delivery) vs Intl | **Intl only**; no date library |
| R-70 | URL filter state | nuqs (stack optional) vs own hook (frontend) | **Own `useUrlQuery`** over shared Zod schemas |
| R-71 | Password hashing | `@node-rs/argon2` (stack) vs `node:crypto` argon2 (security) | **`node:crypto` `argon2id`** (Node ≥ 24.7) |
| R-72 | FS fallback for storage | RustFS 1.0.1 (stack) vs FS adapter (pragmatism) | **FS adapter** (`RECEIPT_STORAGE_DRIVER=fs`) |

---

## C. Red-team ledger

Every red-team finding, in the critic's order. Test files/names are defined in [`00-traceability.md`](./00-traceability.md) §B.

| ID | Sev | Finding | Status | How (or why deferred) |
|---|---|---|---|---|
| RT-B1 | BLOCKER | Cross-section contract conflicts: (a) audit writer, (b) `submissionRepo.close()` vs REVOKE UPDATE, (c) `forbidDerivedWrites` on `$allModels`, (d) four SQLSTATE conventions, (e) two BEFORE UPDATE guards on claims, (f) WAITING vs QUEUED, (g) three role models, (h) request-id 128 vs varchar(64), (i) decimal-string vs integer amount | FIXED-BY-DESIGN | (a) R-04/D-22 single service writer; (b) R-05 INSERT-only, outcome derived; (c) the extension is not built (R-68), so `ExportRun.totalMinor`, `ClaimSubmission.totalMinor` and `ClaimEvent.totalMinor` are ordinary columns and only `claims.total_minor` is guarded (by the DB); (d) R-01 UC class + `error-mapping` unit test + `locked-approved`/`total-desync` raw-SQL cases asserting exact codes via Prisma model op, `$executeRaw` and COMMIT; (e) `claims_guard` is the **only** BEFORE trigger on claims; `schema-objects` test asserts the exact trigger set per table; (f) R-02; (g) R-03; (h) R-54; (i) R-14 |
| RT-B2 | BLOCKER | IDOR via child ids on write paths (foreign line id in my PUT; receipts addressed by id only) | FIXED-BY-DESIGN | D-27: under the owner-scoped claim lock, incoming ids must be ⊆ `SELECT id FROM line_items WHERE claim_id = $claimId` else 404 `LINE_ITEM_NOT_FOUND` before any write; updates `WHERE id AND claim_id`; repository signatures `(tx, actor, claimId, childId)`; receipt routes claim-bound (R-31). Test `authz/child-idor.int.test.ts`. DEFERRED part: DB-level "writer = claimant" check via an actor GUC on child writes — no GUCs by design (R-04); identity is proven by the scoped query |
| RT-B3 | BLOCKER | App container receives owner/superuser credentials via `env_file: .env` | FIXED-BY-DESIGN | D-34: no `env_file` on any service; explicit per-service `environment:`; app `DATABASE_URL` composed from `DB_APP_PASSWORD`; boot self-check (forbidden env vars when `NODE_ENV=production` + `assertRuntimeRole()`); `/api/health/ready` 503 if any integrity trigger is disabled; ports on 127.0.0.1; `e2e/stack-smoke.spec.ts` asserts `docker compose exec app env` has no owner/superuser variables. Periodic drift job in production → DEFERRED (runbook: schedule `pnpm verify:integrity` as a Container Apps Job) |
| RT-M1 | MAJOR | Routing: chain shorter than the tier; any eligible colleague as step 1; app can rewrite tiers | FIXED-BY-DESIGN (1, 3); DEFERRED (2) | (1) `claims_guard` →SUBMITTED requires step count = applicable active tiers, levels 1..n (UC012); (3) SELECT-only on `approval_policy_tiers`, changes via migrations/owner script, privilege test. (2) DB check that the approver is the expected manager DEFERRED — `routing-tiers.int.test.ts` › "stored approvers equal buildChain() for every seeded claim" |
| RT-M2 | MAJOR | DB actor checks fail open / spoofable GUC; audit records a derived actor | FIXED-BY-DESIGN (by removal) | No GUC-based authority exists (R-04). The event's `actor_id` is the authenticated actor written by the service; deferred `assert_transition_audited` requires decision events' `actor_id = approval_steps.approver_id` and submit/recall events' `actor_id = claimant_id`. Residual: code executing as `expense_app` could still forge a consistent event + state change — accepted and stated in the walkthrough ("the DB proves the state machine and audit completeness; the scoped query proves identity"); mitigated by D-34/D-35 and production pgaudit |
| RT-M3 | MAJOR | Receipts: presigned URL replay overwrites approved evidence; racy guard; copy before status check; unbounded presigned PUT size | FIXED-BY-DESIGN | Core has no client-held write credential (server-proxied upload, fresh random key per upload, size enforced before `put`, sha256 stored NOT NULL); `receipts_before_write` locks the parent `FOR NO KEY UPDATE`; editability checked before upload and again under the lock. The §8 presigned flow must follow the quarantine → lock+status check → verify → CopyObject order with TTL ≤ 120 s and a test "reusing the upload policy after confirm leaves the final object unchanged" |
| RT-M4 | MAJOR | Receipt GC deletes evidence referenced by snapshots | FIXED-BY-DESIGN | D-31: objects deleted only for never-submitted claims; no sweeper in core; snapshot stores `storageKey` + `sha256`; download route resolves snapshot-only receipts. Test `rejection-history.int.test.ts` › "receipts referenced by revision 1 stay downloadable after the line is deleted" |
| RT-M5 | MAJOR | Export reproducibility: backdatable timestamps; approvals committing after a period's export | FIXED-BY-DESIGN (backdating, closed periods); DEFERRED (byte-identical rerun of a just-closed period) | D-23 DB-stamped transition timestamps for `expense_app`, UC010 outside transitions; D-32 `asOf` cap + `X-Export-Period-Open` with a 2-minute settle window (≫ 10 s tx timeout). RR snapshot + `export_runs.sha256` byte-identical reruns are OPTIONAL (buffer) |
| RT-M6 | MAJOR | Exported claims change through mutable reference data; `export_runs` tamperable | FIXED-BY-DESIGN | Export reads the approved snapshot (category name, GL code, claimant identity frozen at submit); `expense_app` has SELECT only on reference tables. `export_runs` is OPTIONAL; if built, a trigger allows exactly one RUNNING → SUCCEEDED/FAILED transition and nothing after. Test "renaming a category after approval does not change the CSV". Final approver's email still joins live `users` (owner-only writable) — accepted, documented |
| RT-M7 | MAJOR | App role can write users, roles, departments, categories, tiers | FIXED-BY-DESIGN | D-35 SELECT-only on identity/reference/tier tables; no `user_roles` table; exhaustive `has_table_privilege` test |
| RT-M8 | MAJOR | Approver eligibility not re-checked at decision time | FIXED-BY-DESIGN | D-21 `approval_steps_guard` re-checks on PENDING→APPROVED/REJECTED (UC008) + service role gate (403 `FORBIDDEN`); runbook "stuck PENDING steps with ineligible approver" query; reassign endpoint OPTIONAL. Test "an approver demoted to FINANCE mid-chain is refused by the DB (UC008)" |
| RT-M9 | MAJOR | Approving a stale revision | FIXED-BY-DESIGN | D-17 required `revision`, 409 `REVISION_MISMATCH`; test in `approve-reject.int.test.ts` (+ two-context variant OPTIONAL in Playwright) |
| RT-M10 | MAJOR | Temp-table shadowing; TEMP privilege parity between tests and prod | FIXED-BY-DESIGN | D-36 schema-qualified functions with pinned `search_path`; REVOKE TEMPORARY in `01-roles.sh`; tests use the same script on a single DB (no template clones); `schema-objects` + `privileges` tests |
| RT-M11 | MAJOR | Server Components read through services with no role check | FIXED-BY-DESIGN | D-04 no RSC data reads (ESLint: pages/layouts import only `@/server/auth/rsc`) **and** `requireRole` inside every finance/export service + `financeClaimsWhere(actor)` throws; TC-U09 › "finance and export services throw FORBIDDEN for a non-finance actor before touching the database"; TC-U10 lint fixtures |
| RT-M12 | MAJOR | Session model ambiguity (signed vs opaque) and cookie-name mismatch | FIXED-BY-DESIGN | D-05 opaque DB sessions only, no `AUTH_SECRET`, `createSession()` test helper outside `src`, `sessionCookieName()` shared by auth, cookie writer and proxy; login tests: logout reuse → 401, deactivation → 401, role change → next request |
| RT-m1 | MINOR | Visibility predicates diverge / leak (cancelled approvers, decided approvers see later revisions, finance drafts, `skipped[]` HR leak, finance approve codes) | FIXED-BY-DESIGN, two items decided otherwise | One `claimVisibilityWhere`; CANCELLED/WAITING grant nothing (matrix row "cancelled approver GET → 404"); `skipped[]` not stored; finance approve → 403 `FORBIDDEN`. Decided otherwise: decided approvers keep read access to later revisions (accountability; RM sign-off item); finance sees drafts read-only (spec "sees everything"; list hides them by default) |
| RT-m2 | MINOR | CSV injection gaps | FIXED-BY-DESIGN | D-33: every non-generated text column through `csvText()`, leading whitespace stripped before the test; unit + export tests with payloads in description, merchant, category name, names |
| RT-m3 | MINOR | Export GET CSRF; out-of-scope actors taking row locks | FIXED-BY-DESIGN | `Sec-Fetch-Site: cross-site` on export → 403 `CSRF_REJECTED`; role checks before the transaction and only actor-scoped lock queries (D-14) |
| RT-m4 | MINOR | Claim inserts accept explicit `claim_number`, `created_at`, claimant | FIXED-BY-DESIGN (number, time); DEFERRED (claimant) | `claims_guard` forces `claim_number` and `created_at` for `expense_app`; `claimant_id = actor` is enforced by the service only (no GUC) |
| RT-m5 | MINOR | Route-inventory gaps (HEAD/OPTIONS, three allowlists, login 204 vs 200) | FIXED-BY-DESIGN | Inventory test enumerates GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS; one `PUBLIC_ROUTES` constant; login 200 (R-25) |
| RT-m6 | MINOR | Local exposure (0.0.0.0 ports), admin S3 creds, inline downloads | FIXED-BY-DESIGN (ports, disposition); DEFERRED (S3 identity) | Ports bound to 127.0.0.1; downloads `Content-Disposition: attachment` + `nosniff`. Scoped S3 identity DEFERRED (SeaweedFS admin keys locally; production = managed identity with container-scoped role) |
| RT-m7 | MINOR | Demo credentials leaking to staging/prod | FIXED-BY-DESIGN | D-39 env refinement; seed refuses non-`.test` emails and staging/production |
| RT-m8 | MINOR | Default privileges drift for future tables | FIXED-BY-DESIGN | No DML default privileges; explicit grants per migration; exhaustive privilege test |
| RT-m9 | MINOR | Splitting claims to stay under thresholds | DEFERRED | Policy gap, not an integrity bug; documented limitation; optional finance detective report (same claimant, overlapping dates or same receipt sha256 within N days) |
| RT-m10 | MINOR | Total desync attacks — defended; add COPY, MERGE, opposite-order inserts, overflow → 422 | FIXED-BY-DESIGN | All added to `integrity/total-desync.int.test.ts` and `total-concurrency.int.test.ts`; 22003/23514 map to 422 |
| RT-m11 | MINOR | Approved lock and workflow races — defended | FIXED-BY-DESIGN | Data-section triggers are the single source (R-01/RT-B1e); race tests in `decisions-concurrency.int.test.ts`; repeating the race suite in CI is OPTIONAL |

---

## D. Contracts (verbatim)

### C-01 Roles and actor

| Concept | Representation | Can do |
|---|---|---|
| Claimant (every user) | any active `users` row | create/edit/submit/recall/delete own claims; view own claims |
| Approver | `users.can_approve = true` (role EMPLOYEE or ADMIN) | approve/reject only steps PENDING for them; read claims they have a PENDING/APPROVED/REJECTED step on; `/approvals` |
| Fallback approver | `users.is_fallback_approver = true` (exactly one; must have `can_approve`) | as approver; used when a tier can't resolve otherwise |
| Finance | `users.role = 'FINANCE'` (`can_approve` must be false — CHECK) | read every claim (read-only), finance list, export; never approve/reject/edit others' claims |
| Admin | `users.role = 'ADMIN'` | nothing extra in the app (no UI, no extra visibility); config via owner scripts |

```ts
// src/server/auth/actor.ts
export type UserRole = 'EMPLOYEE' | 'FINANCE' | 'ADMIN';
export interface Actor { id: string; email: string; name: string; role: UserRole; canApprove: boolean }
// UI-facing capability flags (GET /api/v1/auth/me): { canApprove, isFinance: role === 'FINANCE' }
```

### C-02 Enums

| DB enum (snake_case) | Prisma enum | Values |
|---|---|---|
| `user_role` | `UserRole` | `EMPLOYEE`, `FINANCE`, `ADMIN` |
| `claim_status` | `ClaimStatus` | `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED` |
| `approval_step_status` | `ApprovalStepStatus` | `WAITING`, `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `approver_resolver` | `ApproverResolver` | `REPORTING_LINE`, `DESIGNATED_USER` |
| `claim_event_type` | `ClaimEventType` | `CLAIM_SUBMITTED`, `CLAIM_RESUBMITTED`, `STEP_APPROVED`, `CLAIM_APPROVED`, `CLAIM_REJECTED`, `CLAIM_RECALLED` |
| `event_actor_role` | `EventActorRole` | `CLAIMANT`, `APPROVER` |
| `export_run_status` (OPTIONAL) | `ExportRunStatus` | `RUNNING`, `SUCCEEDED`, `FAILED` |
| `receipt_status` (OPTIONAL-§8 only) | `ReceiptStatus` | `PENDING`, `UPLOADED` |

TS-only (not stored):
- `SubmissionOutcome` = `IN_APPROVAL | APPROVED | REJECTED | RECALLED` — derived by `submissionOutcome(steps)` (D-18). This is the "submission status".
- `ClaimAction` = `EDIT | SUBMIT | RECALL | DELETE | APPROVE | REJECT` — `allowedActions` from pure `decide(actor, facts)` in `src/server/authz/claim-policy.ts`.
- Receipt status in core: none — a `receipts` row exists only for an uploaded, verified object.
- `resolved_via` (varchar CHECK) = `PRIMARY | ESCALATED | FALLBACK`.
- Shared Zod enums live in `src/shared/enums.ts` with a compile-time equality check against the Prisma enums on the server.

**Claim transitions** (DB whitelist in `claims_guard`, UC005 otherwise):

| From → To | Trigger | Actor | Service preconditions (after lock) | Event |
|---|---|---|---|---|
| (new) → DRAFT | `POST /claims` | claimant | — | none (log `claim.created`) |
| DRAFT → SUBMITTED | `POST /submit` | owner | ≥ 1 line, categories active, chain resolvable | `CLAIM_SUBMITTED` |
| REJECTED → SUBMITTED | `POST /submit` | owner | same | `CLAIM_RESUBMITTED` |
| SUBMITTED → SUBMITTED | `POST /approve` (non-final) | approver with PENDING step | revision matches | `STEP_APPROVED` |
| SUBMITTED → APPROVED | `POST /approve` (final) | approver with PENDING step | revision matches | `CLAIM_APPROVED` |
| SUBMITTED → REJECTED | `POST /reject` | approver with PENDING step | revision matches, reason 10..1000 | `CLAIM_REJECTED` |
| SUBMITTED → DRAFT | `POST /recall` | owner | status SUBMITTED | `CLAIM_RECALLED` |
| DRAFT → (deleted) | `DELETE /claims/:id` | owner | `current_revision = 0` | none (log `claim.deleted`) |
| APPROVED → anything | — | — | — | refused: 409 `CLAIM_LOCKED` / UC001 |

**Step transitions** (`approval_steps_guard`): insert as `PENDING` (level 1, `activated_at` stamped) or `WAITING` (levels 2..n); `WAITING → PENDING` (previous level APPROVED); `WAITING → CANCELLED` (rejection at an earlier level, or recall); `PENDING → APPROVED | REJECTED` (decision; eligibility re-checked); `PENDING → CANCELLED` (recall). APPROVED/REJECTED/CANCELLED are terminal (UC006). At most one PENDING per submission (partial unique index).

**Action × status → result** (owner unless noted):

| Action \ status | DRAFT | SUBMITTED | APPROVED | REJECTED |
|---|---|---|---|---|
| PUT (edit title/lines) | 200 | 409 `CLAIM_NOT_EDITABLE` (hint `RECALL_TO_EDIT`) | 409 `CLAIM_LOCKED` | 200 |
| Receipt upload/delete | 201/204 | 409 `CLAIM_NOT_EDITABLE` | 409 `CLAIM_LOCKED` | 201/204 |
| DELETE claim | 204 if rev 0, else 409 `CLAIM_HAS_HISTORY` | 409 `CLAIM_HAS_HISTORY` | 409 `CLAIM_LOCKED` | 409 `CLAIM_HAS_HISTORY` |
| Submit | 200 (422 `NO_LINE_ITEMS` if empty) | 409 `INVALID_STATUS_TRANSITION` | 409 `CLAIM_LOCKED` | 200 |
| Recall | 409 `INVALID_STATUS_TRANSITION` | 200 | 409 `CLAIM_LOCKED` | 409 `INVALID_STATUS_TRANSITION` |
| Approve/reject (approver) | 409 `ALREADY_DECIDED` if I decided the current (recalled) revision, else 403 `NOT_IN_YOUR_QUEUE` | 200 if my step PENDING; 409 `REVISION_MISMATCH` if stale; 409 `ALREADY_DECIDED` if I decided this revision; else 403 `NOT_IN_YOUR_QUEUE` | 409 `ALREADY_DECIDED` if I decided it, else 403 `NOT_IN_YOUR_QUEUE` | 409 `ALREADY_DECIDED` if I decided it, else 403 `NOT_IN_YOUR_QUEUE` |
| Any owner action by a non-owner (incl. finance) | 404 `CLAIM_NOT_FOUND` | ← | ← | ← |
| Approve/reject by FINANCE or a user without `can_approve` | 403 `FORBIDDEN` | ← | ← | ← |

### C-03 Tables and key columns

Conventions: table `snake_case` plural ↔ Prisma model `PascalCase` singular; column `snake_case` ↔ Prisma field = camelCase (`@map`); every PK `id uuid DEFAULT uuidv7()`; every instant `timestamptz(3)`; `created_at DEFAULT now()`; `updated_at` maintained by Prisma `@updatedAt`. Generated client: `@/generated/prisma/client` (generator `prisma-client`, output `../src/generated/prisma`, `moduleFormat = "esm"`, `previewFeatures = ["partialIndexes"]`). Datasource URL comes from `prisma.config.ts` (`MIGRATE_DATABASE_URL ?? DATABASE_URL`) for the CLI and from the `PrismaPg` adapter (`DATABASE_URL`) at runtime.

| Table (Prisma model) | Columns | Keys and constraints |
|---|---|---|
| `departments` (`Department`) | `id`, `code varchar(16)`, `name varchar(120)`, `created_at` | `code` UNIQUE |
| `users` (`User`) | `id`, `employee_code varchar(20)`, `email varchar(254)`, `name varchar(120)`, `role user_role DEFAULT 'EMPLOYEE'`, `can_approve bool DEFAULT false`, `is_fallback_approver bool DEFAULT false`, `is_active bool DEFAULT true`, `department_id → departments`, `manager_id → users NULL`, `password_hash text NULL`, `created_at`, `updated_at` | `employee_code`, `email` UNIQUE; CHECK `users_email_lowercase (email = lower(email))`; CHECK `users_finance_cannot_approve NOT (role = 'FINANCE' AND can_approve)`; CHECK `users_fallback_must_approve (NOT is_fallback_approver OR can_approve)`; CHECK `users_not_own_manager (manager_id <> id)`; partial UNIQUE `users_one_fallback_approver (is_fallback_approver) WHERE is_fallback_approver`; index `manager_id`. Never deleted (deactivate) |
| `sessions` (`Session`) | `id`, `user_id → users ON DELETE CASCADE`, `token_hash char(64)`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `user_agent varchar(512) NULL` | `token_hash` UNIQUE; index `user_id` |
| `categories` (`Category`) | `id`, `code varchar(32)`, `name varchar(80)`, `gl_code varchar(20)`, `is_active bool DEFAULT true`, `sort_order smallint DEFAULT 0` | `code` UNIQUE; CHECK `categories_gl_code_format (gl_code ~ '^[0-9]{4,10}$')` |
| `approval_policy_tiers` (`ApprovalPolicyTier`) | `id`, `level smallint`, `code varchar(32)`, `label varchar(80)`, `applies_above_minor int`, `resolver approver_resolver`, `levels_up smallint NULL`, `designated_user_id → users NULL`, `is_active bool DEFAULT true`, `created_at` | `level` UNIQUE, `code` UNIQUE; CHECK `level >= 1`; CHECK `applies_above_minor >= 0`; CHECK `levels_up BETWEEN 1 AND 5`; CHECK `tiers_resolver_shape ((resolver = 'REPORTING_LINE' AND levels_up IS NOT NULL AND designated_user_id IS NULL) OR (resolver = 'DESIGNATED_USER' AND designated_user_id IS NOT NULL AND levels_up IS NULL))` |
| `claims` (`Claim`) | `id`, `claim_number varchar(24) DEFAULT next_claim_number()`, `claimant_id → users`, `title varchar(120)`, `currency char(3) DEFAULT 'INR'`, `status claim_status DEFAULT 'DRAFT'`, `total_minor int DEFAULT 0` (**DERIVED — trigger-only**), `current_revision int DEFAULT 0`, `current_submission_id → claim_submissions NULL`, `submitted_at NULL`, `approved_at NULL`, `rejected_at NULL`, `created_at`, `updated_at` | `claim_number` UNIQUE + CHECK `^EXP-[0-9]{4}-[0-9]{6,}$`; `current_submission_id` UNIQUE; CHECK `claims_total_range (total_minor BETWEEN 0 AND 1000000000)`; CHECK `claims_approved_at_iff_approved ((status = 'APPROVED') = (approved_at IS NOT NULL))`; CHECK `claims_rejected_at_iff_rejected ((status = 'REJECTED') = (rejected_at IS NOT NULL))`; CHECK `claims_revision_matches_submission ((current_revision = 0) = (current_submission_id IS NULL))`; CHECK `claims_submitted_has_revision (status = 'DRAFT' OR current_revision >= 1)`; CHECK `claims_title_length (char_length(btrim(title)) BETWEEN 3 AND 120)`; CHECK `currency ~ '^[A-Z]{3}$'` |
| `line_items` (`LineItem`) | `id`, `claim_id → claims ON DELETE CASCADE` (**immutable**), `category_id → categories ON DELETE RESTRICT`, `expense_date date`, `amount_minor int`, `description varchar(500)`, `merchant varchar(120) NULL`, `created_at`, `updated_at` | UNIQUE `line_items_id_claim_id_key (id, claim_id)`; CHECK `line_items_amount_range (amount_minor BETWEEN 1 AND 100000000)`; CHECK `line_items_expense_date_min (expense_date >= DATE '2000-01-01')`; CHECK `line_items_description_length (char_length(btrim(description)) BETWEEN 3 AND 500)` |
| `receipts` (`Receipt`) | `id`, `claim_id`, `line_item_id`, `storage_key varchar(512)`, `file_name varchar(255)`, `content_type varchar(100)`, `size_bytes int`, `sha256 char(64)`, `uploaded_by_id → users`, `created_at` | FK `(line_item_id, claim_id) → line_items(id, claim_id) ON DELETE CASCADE`; `storage_key` UNIQUE; CHECK `content_type IN ('image/jpeg','image/png','image/webp','application/pdf')`; CHECK `size_bytes BETWEEN 1 AND 10485760`; CHECK `sha256 ~ '^[0-9a-f]{64}$'`; index `line_item_id` |
| `claim_submissions` (`ClaimSubmission`) | `id`, `claim_id → claims ON DELETE RESTRICT`, `revision int`, `submitted_by_id → users`, `submitted_at`, `total_minor int`, `currency char(3)`, `line_item_count int`, `snapshot jsonb`, `created_at` | UNIQUE `(claim_id, revision)`; UNIQUE `claim_submissions_id_claim_id_key (id, claim_id)`; CHECK `revision >= 1`, `total_minor > 0`, `line_item_count >= 1`. INSERT-only |
| `approval_steps` (`ApprovalStep`) | `id`, `claim_id`, `submission_id`, `level smallint`, `tier_code varchar(32)`, `tier_label varchar(80)`, `applies_above_minor int`, `approver_id → users`, `resolved_via varchar(16)`, `status approval_step_status`, `activated_at NULL`, `decided_at NULL`, `cancelled_at NULL`, `comment varchar(1000) NULL`, `rejection_reason varchar(1000) NULL`, `created_at` | FK `(submission_id, claim_id) → claim_submissions(id, claim_id)`; plain FK `claim_id → claims` (fallback if Prisma rejects the double relation: drop it and reach the claim via the submission); UNIQUE `(submission_id, level)`; UNIQUE `(submission_id, approver_id)`; CHECK `level >= 1`; CHECK `resolved_via IN ('PRIMARY','ESCALATED','FALLBACK')`; CHECK `steps_activated (status IN ('WAITING','CANCELLED') OR activated_at IS NOT NULL)`; CHECK `steps_decided_iff ((status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL))`; CHECK `steps_cancelled_iff ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))`; CHECK `steps_reason_iff_rejected ((status = 'REJECTED') = (rejection_reason IS NOT NULL))`; CHECK `steps_reason_length (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 10 AND 1000)`; CHECK `steps_comment_only_on_approve (comment IS NULL OR status = 'APPROVED')`. No DELETE |
| `claim_events` (`ClaimEvent`) | `id`, `claim_id → claims ON DELETE RESTRICT`, `submission_id → claim_submissions NULL`, `step_id → approval_steps NULL`, `revision int`, `type claim_event_type`, `actor_id → users`, `actor_role event_actor_role`, `from_status claim_status`, `to_status claim_status`, `total_minor int`, `reason varchar(1000) NULL`, `payload jsonb DEFAULT '{}'`, `request_id varchar(64)`, `tx_id bigint DEFAULT (pg_current_xact_id()::text)::bigint`, `occurred_at DEFAULT now()` | all NOT NULL except `submission_id`, `step_id`, `reason`; append-only (UC007) |
| `export_runs` (`ExportRun`) — OPTIONAL | `id`, `requested_by_id → users`, `period_from date`, `period_to date`, `as_of`, `status export_run_status`, `claim_count int`, `line_count int`, `total_minor bigint`, `sha256 char(64)`, `request_id varchar(64)`, `started_at`, `completed_at`, `error_code varchar(64)` | terminal rows immutable (trigger) |

Other objects: sequence `claim_number_seq`; function `next_claim_number()`; view `v_claim_total_drift (claim_id, total_minor, line_sum)` = claims whose `total_minor <> COALESCE(SUM(line_items.amount_minor), 0)`.

**Indexes** (names are contract):
- `claims_claimant_list_idx (claimant_id, created_at DESC, id DESC)` — claimant list
- `claims_finance_list_idx (status, submitted_at DESC, id DESC)` — finance list, single status
- `claims_submitted_idx (submitted_at DESC, id DESC)` — finance list, default multi-status
- `claims_export_idx (approved_at, id)` — export batches, finance `dateField=approvedAt`
- `line_items_claim_idx (claim_id, expense_date, id)` — recompute SUM, ordered lines
- `receipts_line_item_idx (line_item_id)`
- `approval_steps_pending_queue_idx (approver_id, activated_at, id) WHERE status = 'PENDING'` — partial; the queue
- `approval_steps_one_pending_per_submission UNIQUE (submission_id) WHERE status = 'PENDING'` — partial unique
- `approval_steps_approver_history_idx (approver_id, decided_at DESC, id DESC)` — decided tab
- `approval_steps_visibility_idx (claim_id, approver_id)` — visibility EXISTS
- `claim_events_timeline_idx (claim_id, occurred_at, id)` — history
- `users_one_fallback_approver UNIQUE (is_fallback_approver) WHERE is_fallback_approver` — partial unique

### C-04 Functions and triggers (the PL/pgSQL budget: 10 functions + 1 SQL function)

All functions: schema-qualified, `SET search_path = pg_catalog, public, pg_temp`. Trigger names use `<table>_<NN>_<purpose>` (same-kind triggers fire alphabetically).

| # | Function | Triggers (table: name — timing) | Rules | Migration / phase |
|---|---|---|---|---|
| 1 | `assert_claim_editable(claim_id)` | helper | locks the claim `FOR NO KEY UPDATE`; APPROVED → UC001; SUBMITTED → UC002; v2 adds the snapshot freeze (a submission with `revision > current_revision` exists → UC002; BUG-2) | 0002 (v1) + 0004 (v2) / P0, P3 |
| 2 | `line_items_before_write()` | `line_items: line_items_10_before_write` — BEFORE INSERT/UPDATE/DELETE, row | calls #1 on the parent (OLD and NEW); `claim_id` change → UC010; inactive category on insert or category change → UC013; `expense_date > (now() AT TIME ZONE 'Asia/Kolkata')::date` → UC014 | 0002 / P0 |
| 3 | `line_items_recompute_claim_totals()` | `line_items: line_items_20_recompute_after_insert / _after_update / _after_delete` — AFTER STATEMENT, `REFERENCING NEW/OLD TABLE` | lock affected claims `ORDER BY id FOR NO KEY UPDATE`; full SUM recompute; UPDATE recomputes old and new parents | 0002 / P0 |
| 4 | `claims_guard()` | `claims: claims_10_guard` — BEFORE INSERT/UPDATE/DELETE, row | INSERT (all roles): total ≠ 0 → UC003; status ≠ DRAFT, revision ≠ 0 or a submission pointer → UC005 (a claim is born an empty DRAFT, so seeds and the perf generator must walk legal transitions); for `expense_app` additionally force `claim_number := next_claim_number()`, `created_at := now()`. UPDATE: OLD APPROVED → UC001; `total_minor` changed at `pg_trigger_depth() < 2` → UC003; `claimant_id/claim_number/currency/created_at` changed → UC010; title change while SUBMITTED → UC002; transition not whitelisted → UC005; →SUBMITTED: 0 lines → UC004, chain shape ≠ applicable active tiers / level 1 not PENDING / submission not this claim's newest → UC012, stamp `submitted_at`, clear `rejected_at`; →APPROVED: any current step not APPROVED → UC011, stamp `approved_at`; →REJECTED: no REJECTED step or open steps remain → UC011, stamp `rejected_at`; →DRAFT (recall): open steps remain → UC012; transition timestamps changed outside their transition (for `expense_app`) → UC010. DELETE: APPROVED → UC001; `current_revision > 0` → UC017 | 0002 (v1) + 0004 (v2) / P0, P3 |
| 5 | `assert_claim_total_consistent()` | `line_items: line_items_90_total_consistent`, `claims: claims_90_total_consistent` — CONSTRAINT, DEFERRABLE INITIALLY DEFERRED, row | `claims.total_minor ≠ Σ lines` at COMMIT → UC009 (skips deleted claims) | 0002 / P0 |
| 6 | `claim_submissions_verify()` | `claim_submissions: claim_submissions_10_verify` — BEFORE INSERT | per D-18 (UC002/UC001 via #1, UC004, UC016); stamp `submitted_at` for `expense_app`; v1 refuses any snapshot receipts (UC016), v2 verifies them against live `receipts` | 0004 (v1) + 0005 (v2) / P3, P6 |
| 7 | `approval_steps_guard()` | `approval_steps: approval_steps_10_guard` — BEFORE INSERT/UPDATE/DELETE | per D-21 (UC008, UC012, UC006, UC010, UC005 for illegal step transitions, DELETE → UC007); stamps `activated_at/decided_at/cancelled_at` for `expense_app` | 0004 / P3 |
| 8 | `forbid_mutation()` | `claim_submissions: claim_submissions_00_append_only` — BEFORE UPDATE/DELETE; `claim_events: claim_events_00_guard` — BEFORE INSERT/UPDATE/DELETE | UPDATE/DELETE → UC007; on `claim_events` INSERT by `expense_app` stamp `occurred_at := now()`, `tx_id := pg_current_xact_id()` | 0004 / P3 |
| 9 | `assert_transition_audited()` | `claims: claims_95_transition_audited` — CONSTRAINT AFTER UPDATE OF status, DEFERRABLE INITIALLY DEFERRED; `approval_steps: approval_steps_95_transition_audited` — same, fires for → APPROVED/REJECTED | per D-22 → UC015 | 0004 / P3 |
| 10 | `receipts_before_write()` | `receipts: receipts_10_before_write` — BEFORE INSERT/UPDATE/DELETE, row | calls #1 on the parent; `claim_id/line_item_id` change → UC010 | 0005 / P6 |
| — | `next_claim_number()` (SQL) | default of `claims.claim_number` | `'EXP-' || to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY') || '-' || lpad(n::text, greatest(6, length(n::text)), '0')` | 0001 (prepended) / P0 |

### C-05 SQLSTATE ↔ API mapping

Raise convention: `RAISE EXCEPTION USING ERRCODE = 'UC001', MESSAGE = 'CLAIM_LOCKED: claim <id> is approved and read-only', DETAIL = '<context>';`. The app maps **by SQLSTATE only** in `src/server/errors/map-error.ts`, reading the code with `readSqlState(err)` in `src/server/db/pg-error.ts`, which handles Prisma P2039/P2010 `meta.driverAdapterError.cause.originalCode` (or `.code`), a raw `DriverAdapterError` thrown at COMMIT (`err.cause.originalCode`), and node-postgres `DatabaseError.code`. The exact shapes are recorded by the P0 spike. "500" rows are logged at `error` with `defense: 'db'`.

| SQLSTATE | Name | Raised when | API code | HTTP |
|---|---|---|---|---|
| UC001 | CLAIM_LOCKED | any write to an APPROVED claim, its lines or receipts | `CLAIM_LOCKED` | 409 |
| UC002 | CLAIM_NOT_EDITABLE | line/receipt/title write while SUBMITTED | `CLAIM_NOT_EDITABLE` | 409 |
| UC003 | TOTAL_IS_DERIVED | `total_minor` written outside the recompute trigger; claim inserted with total ≠ 0 | `TOTAL_IS_DERIVED` | 422 |
| UC004 | NO_LINE_ITEMS | → SUBMITTED with zero lines; empty snapshot | `NO_LINE_ITEMS` | 422 |
| UC005 | INVALID_STATUS_TRANSITION | claim or step transition not whitelisted | `INVALID_STATUS_TRANSITION` | 409 |
| UC006 | ALREADY_DECIDED | update of an APPROVED/REJECTED/CANCELLED step | `ALREADY_DECIDED` | 409 |
| UC007 | APPEND_ONLY | UPDATE/DELETE on `claim_events`/`claim_submissions`; DELETE on `approval_steps` | `INTERNAL_ERROR` | 500 |
| UC008 | APPROVER_NOT_ELIGIBLE | step approver is the claimant, FINANCE, inactive or lacks `can_approve` (insert or decision) | `INTERNAL_ERROR` | 500 |
| UC009 | TOTAL_MISMATCH | commit-time `total_minor ≠ Σ lines` | `INTERNAL_ERROR` | 500 |
| UC010 | IMMUTABLE_FIELD | change of an immutable column or a DB-owned timestamp | `INTERNAL_ERROR` | 500 |
| UC011 | APPROVAL_INCOMPLETE | → APPROVED without every step APPROVED; → REJECTED without a REJECTED step / with open steps | `INTERNAL_ERROR` | 500 |
| UC012 | CHAIN_INVALID | chain length ≠ applicable active tiers, levels not 1..n, wrong initial statuses, WAITING → PENDING out of order, step insert outside a submit, recall leaving open steps | `INTERNAL_ERROR` | 500 |
| UC013 | CATEGORY_INACTIVE | new/changed line uses an inactive category | `CATEGORY_INACTIVE` | 422 |
| UC014 | EXPENSE_DATE_IN_FUTURE | `expense_date` after today (IST) | `VALIDATION_FAILED` (`issues[0].path = ['lineItems']`) | 422 |
| UC015 | AUDIT_EVENT_MISSING | status change / decision without a matching event in the same transaction, or actor mismatch | `INTERNAL_ERROR` | 500 |
| UC016 | SNAPSHOT_MISMATCH | snapshot ≠ live lines/total, wrong revision, submitter ≠ claimant | `INTERNAL_ERROR` | 500 |
| UC017 | CLAIM_HAS_HISTORY | DELETE of a claim with `current_revision > 0` | `CLAIM_HAS_HISTORY` | 409 |
| 23514 | check_violation | DB CHECK (e.g. `claims_total_range`) | `VALIDATION_FAILED` (`details.constraint`) | 422 |
| 23503 | foreign_key_violation | e.g. unknown category | `VALIDATION_FAILED` | 422 |
| 22003 / 22001 | numeric out of range / string too long | int4 overflow of a SUM, oversize text | `VALIDATION_FAILED` | 422 |
| 23505 | unique_violation | duplicate (race) | `CONFLICT` | 409 |
| 40001 / 40P01 | serialization failure / deadlock | — | retried ×2, then `CONFLICT` (`details.retryable = true`) | 409 |
| 55P03 | lock_not_available | `lock_timeout` 5 s | `CONFLICT` | 409 |
| 57014 | query_canceled | `statement_timeout` | `SERVICE_UNAVAILABLE` | 503 |
| 42501 | insufficient_privilege | app attempted a forbidden operation | `INTERNAL_ERROR` | 500 |
| 08xxx, 57P01; Prisma P1001/P1017/P2024 | connection failures | — | `SERVICE_UNAVAILABLE` | 503 |
| Prisma P2002 / P2025 / P2034 | unique / not found / tx conflict | — | `CONFLICT` 409 / resource `*_NOT_FOUND` 404 / retry then `CONFLICT` 409 | |

### C-06 Error-code catalogue

Single source: `src/shared/errors.ts` (code list for the client) and `src/server/errors/codes.ts` (code → HTTP status). `AppError(code, message, details?)` in `src/server/errors/app-error.ts`. 5xx bodies are always the generic message + `requestId`, never details, stack or SQL.

| Code | HTTP | When |
|---|---|---|
| `MALFORMED_JSON` | 400 | body is not parseable JSON |
| `UNAUTHENTICATED` | 401 | no / garbage / expired / revoked session, or deactivated user |
| `INVALID_CREDENTIALS` | 401 | login failed (unknown email, wrong password, inactive user — identical body) |
| `CSRF_REJECTED` | 403 | unsafe method (or the export GET) with a cross-site `Origin` / `Sec-Fetch-Site` |
| `FORBIDDEN` | 403 | role gate: no `can_approve` (or FINANCE) on `/approvals`, approve, reject; non-FINANCE on `/finance/*`; service-level `requireRole` |
| `NOT_IN_YOUR_QUEUE` | 403 | approve/reject with no PENDING step for the caller on that claim (incl. nonexistent ids, WAITING steps, other approvers' claims) |
| `CLAIM_NOT_FOUND` | 404 | claim not visible (reads) or not owned (owner writes), or malformed claim UUID |
| `LINE_ITEM_NOT_FOUND` | 404 | line id in a PUT body or receipt path that doesn't belong to the path claim |
| `RECEIPT_NOT_FOUND` | 404 | receipt not attached to (or snapshotted by) the visible path claim |
| `ROUTE_NOT_FOUND` | 404 | unknown `/api/v1/*` path (catch-all; authenticated) |
| `CLAIM_LOCKED` | 409 | any write to an APPROVED claim (`details.status = 'APPROVED'`) |
| `CLAIM_NOT_EDITABLE` | 409 | edit/receipt write while SUBMITTED (`details.hint = 'RECALL_TO_EDIT'`) |
| `INVALID_STATUS_TRANSITION` | 409 | submit while SUBMITTED; recall unless SUBMITTED |
| `ALREADY_DECIDED` | 409 | approve/reject when the caller already decided the current revision |
| `REVISION_MISMATCH` | 409 | approve/reject `revision ≠ current_revision` (`details: {requestedRevision, currentRevision}`) |
| `CLAIM_HAS_HISTORY` | 409 | DELETE of a claim that was ever submitted |
| `CONFLICT` | 409 | concurrency after retries, lock timeout, unique race (`details.retryable = true`) |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body > 256 KiB; receipt > 10 MiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | non-JSON body on a JSON route; non-multipart on the upload route |
| `VALIDATION_FAILED` | 422 | Zod issues (`details.issues[{path, message, code}]`), unknown category, DB CHECK/FK/overflow backstops, `from > to` |
| `TOTAL_IS_DERIVED` | 422 | body contains a total-like key; UC003 |
| `READ_ONLY_FIELD` | 422 | body contains another server-owned key (`details.issues[].path`) |
| `NO_LINE_ITEMS` | 422 | submit with zero lines; UC004 |
| `CATEGORY_INACTIVE` | 422 | line uses an inactive category; UC013 |
| `ROUTING_UNRESOLVABLE` | 422 | a tier has no eligible approver (`details: {tierCode, level}`) |
| `RECEIPT_TYPE_NOT_ALLOWED` | 422 | content type not allowed or magic bytes don't match |
| `RECEIPT_LIMIT_REACHED` | 422 | 6th receipt on a line |
| `INVALID_CURSOR` | 422 | cursor malformed or issued for different filters |
| `EXPORT_RANGE_TOO_LARGE` | 422 | export span > 366 days |
| `EXPORT_STATUS_NOT_ALLOWED` | 422 | export `status` ≠ `APPROVED` (message cites §3.6) |
| `RATE_LIMITED` | 429 | OPTIONAL login throttling (`Retry-After`) |
| `INTERNAL_ERROR` | 500 | unexpected errors and DB-backstop SQLSTATEs (C-05) |
| `SERVICE_UNAVAILABLE` | 503 | DB unreachable / statement timeout / storage unavailable |
| `NOT_READY` | 503 | `/api/health/ready` failing |

### C-07 API routes

All `/api/v1/*` routes require authentication except login. "Role gate" is checked by `defineRoute({ roles })` before any query; "scope" is the repository predicate.

| # | Method | Path | Role gate / scope | Body / query | Success |
|---|---|---|---|---|---|
| 1 | POST | `/api/v1/auth/login` | **public** | `{ email, password }` | 200 `{data:{user}}` + Set-Cookie |
| 2 | GET | `/api/health/live` | **public** | — | 200 `{data:{status:'live'}}` |
| 3 | GET | `/api/health/ready` | **public** | — | 200 / 503 `NOT_READY` |
| 4 | POST | `/api/v1/auth/logout` | any | — | 204 + cookie cleared |
| 5 | GET | `/api/v1/auth/me` | any | — | 200 `{data: MeDto}` |
| 6 | GET | `/api/v1/categories` | any | — | 200 `{data: Category[]}` (incl. `isActive`) |
| 7 | GET | `/api/v1/claims` | any; scope own | `ClaimListQuery` | 200 list of `ClaimSummary` |
| 8 | POST | `/api/v1/claims` | any; creates own DRAFT | `CreateClaimInput` | 201 `ClaimDetail` |
| 9 | GET | `/api/v1/claims/:claimId` | visible | — | 200 `ClaimDetail` |
| 10 | PUT | `/api/v1/claims/:claimId` | owner; DRAFT/REJECTED | `ReplaceClaimInput` | 200 `ClaimDetail` |
| 11 | DELETE | `/api/v1/claims/:claimId` | owner; never-submitted DRAFT | — | 204 |
| 12 | POST | `/api/v1/claims/:claimId/submit` | owner; DRAFT/REJECTED | `{}` (optional body) | 200 `ClaimDetail` |
| 13 | POST | `/api/v1/claims/:claimId/recall` | owner; SUBMITTED | `RecallInput` | 200 `ClaimDetail` |
| 14 | POST | `/api/v1/claims/:claimId/approve` | `canApprove && role ≠ FINANCE`; my PENDING step | `ApproveInput` | 200 `ClaimDetail` |
| 15 | POST | `/api/v1/claims/:claimId/reject` | same | `RejectInput` | 200 `ClaimDetail` |
| 16 | GET | `/api/v1/claims/:claimId/history` | visible | — | 200 `ClaimHistory` |
| 17 | POST | `/api/v1/claims/:claimId/line-items/:lineItemId/receipts` | owner; editable | multipart `file` | 201 `ReceiptDto` |
| 18 | GET | `/api/v1/claims/:claimId/receipts/:receiptId/content` | visible | — | 200 file stream |
| 19 | DELETE | `/api/v1/claims/:claimId/receipts/:receiptId` | owner; editable | — | 204 |
| 20 | GET | `/api/v1/approvals` | `canApprove && role ≠ FINANCE`; scope `approver_id = me` | `ApprovalQueueQuery` | 200 list of `ApprovalTask` |
| 21 | GET | `/api/v1/finance/claims` | FINANCE | `FinanceClaimsQuery` | 200 list of `ClaimSummary` (+ claimant) |
| 22 | GET | `/api/v1/finance/exports/approved-claims` | FINANCE | `ExportQuery` | 200 `text/csv` stream |
| 23 | ALL | `/api/v1/[...path]` | any | — | 404 `ROUTE_NOT_FOUND` |

OPTIONAL routes: `GET /api/v1/finance/exports/approved-claims/summary` (FINANCE); `GET /api/v1/finance/exports` (`export_runs`); §8 `POST /api/v1/claims/:claimId/line-items/:lineItemId/receipts/upload-intent` + `POST /api/v1/claims/:claimId/receipts/:receiptId/confirm`; `GET /api/v1/claims/:claimId/routing-preview`; `POST /api/v1/admin/approval-steps/:stepId/reassign` (`STEP_REASSIGNED` event).

Route files: `src/app/api/v1/<path>/route.ts` mirroring the path (`[claimId]`, `[lineItemId]`, `[receiptId]`, `[...path]`); health at `src/app/api/health/{live,ready}/route.ts`. `PUBLIC_ROUTES = ['POST /api/v1/auth/login', 'GET /api/health/live', 'GET /api/health/ready']` in `src/server/http/public-routes.ts`.

**Page routes** (UX gates only): `/login`; `/` → redirect `/claims`; `/claims`; `/claims/new`; `/claims/[id]`; `/approvals` (`?status=PENDING` default, Decided = `APPROVED,REJECTED`); `/approvals/[claimId]`; `/finance/claims`; `/finance/claims/[id]`; `/finance/export`; `not-found.tsx`; `<NotFoundView kind="claim">` and `<ForbiddenView>` components.

### C-08 Envelopes and headers

```jsonc
// success
{ "data": { /* T */ } }
// list
{ "data": [ /* T */ ], "page": { "nextCursor": "eyJ…" /* or null */, "limit": 25 } }
// error
{ "error": { "code": "CLAIM_LOCKED", "message": "This claim is approved and locked.", "details": { "status": "APPROVED" }, "requestId": "0f6c…" } }
// VALIDATION_FAILED details
{ "issues": [ { "path": ["lineItems", 0, "amountMinor"], "message": "Must be at least 1", "code": "too_small" } ] }
```

Every API response: `x-request-id`, `Cache-Control: no-store`. JSON `Content-Type: application/json`. Logout and deletes: 204, no body. Export: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="approved-claims_<from>_<to>.csv"`, `X-Export-As-Of: <ISO>`, `X-Export-Period-Open: true|false`. Receipt content: stored `Content-Type`, `Content-Disposition: attachment; filename="<file_name>"`, `X-Content-Type-Options: nosniff`.

### C-09 Pagination and filter parameters

Common: `limit` int 1..100 (default 25); `cursor` = base64url(JSON `{ sort, value, id, fh }`) where `fh` = short hash of the normalised filters (mismatch or tamper → 422 `INVALID_CURSOR`); `from`, `to` = inclusive `YYYY-MM-DD` in Asia/Kolkata, `from ≤ to` (else 422 `VALIDATION_FAILED`); unknown params → 422 `VALIDATION_FAILED`. Fixed sort per endpoint; `LIMIT limit+1` to compute `nextCursor`.

| Endpoint | `status` | Date field for `from`/`to` | Sort (keyset) | Index |
|---|---|---|---|---|
| `GET /claims` | CSV of `DRAFT,SUBMITTED,APPROVED,REJECTED` (default all) | `created_at` | `created_at DESC, id DESC` | `claims_claimant_list_idx` |
| `GET /approvals` | `PENDING` (default) or `APPROVED`, `REJECTED`, `APPROVED,REJECTED`; PENDING can't be combined (422) | PENDING: `activated_at`; decided: `decided_at` | PENDING: `activated_at ASC, id ASC`; decided: `decided_at DESC, id DESC` | `approval_steps_pending_queue_idx` / `approval_steps_approver_history_idx` |
| `GET /finance/claims` | CSV of ClaimStatus (default `SUBMITTED,APPROVED,REJECTED`; `DRAFT` only if listed) | `dateField` = `submittedAt` (default) or `approvedAt` | `<dateField> DESC, id DESC` | `claims_submitted_idx` / `claims_finance_list_idx` / `claims_export_idx` |
| `GET /finance/exports/approved-claims` | optional, only `APPROVED` (else 422 `EXPORT_STATUS_NOT_ALLOWED`) | `approved_at` (`from`, `to` **required**, ≤ 366 days) | `approved_at ASC, id ASC`, batches of `EXPORT_BATCH_SIZE` | `claims_export_idx` |

### C-10 Request bodies and DTOs

Schemas live in `src/shared/schemas/*` (requests, strict) and `src/shared/dto/*` (responses; the client parses responses with them).

```ts
LoginInput          = { email: string; password: string }
LineItemInput       = { id?: uuid; expenseDate: 'YYYY-MM-DD'; categoryId: uuid; amountMinor: int 1..100000000; description: string 3..500; merchant?: string ≤120 }
CreateClaimInput    = { title: string 3..120; lineItems?: LineItemInput[] /* 0..50, no ids */ }
ReplaceClaimInput   = { title: string 3..120; lineItems: LineItemInput[] /* 0..50 */ }
SubmitInput         = {}                                  // strict empty object; body optional
RecallInput         = { note?: string ≤500 }
ApproveInput        = { revision: int ≥1; comment?: string ≤1000 }
RejectInput         = { revision: int ≥1; reason: string trimmed 10..1000 }
ClaimListQuery      = { status?; from?; to?; cursor?; limit? }
ApprovalQueueQuery  = { status?; from?; to?; cursor?; limit? }
FinanceClaimsQuery  = { status?; dateField?: 'submittedAt' | 'approvedAt'; from?; to?; cursor?; limit? }
ExportQuery         = { from: 'YYYY-MM-DD'; to: 'YYYY-MM-DD'; status?: 'APPROVED' }

MeDto         = { id; email; name; role; canApprove; isFinance }
UserRef       = { id; name; email? }
CategoryDto   = { id; code; name; isActive }
ReceiptDto    = { id; fileName; contentType; sizeBytes; createdAt }
ClaimSummary  = { id; claimNumber; title; status; currency; totalMinor; currentRevision; lineItemCount; claimant?: UserRef; createdAt; submittedAt; approvedAt; currentLevel?: number; levelCount?: number }
ClaimDetail   = { id; claimNumber; title; status; currency; totalMinor; currentRevision; claimant: UserRef;
                  createdAt; submittedAt; approvedAt; rejectedAt;
                  lineItems: { id; expenseDate; category: CategoryDto; amountMinor; description; merchant; receipts: ReceiptDto[] }[];
                  approval: { revision; steps: { level; tierCode; tierLabel; approver: UserRef; status; activatedAt; decidedAt; comment; rejectionReason }[] } | null;
                  lastRejection: { revision; level; reason; by: UserRef; at } | null;
                  allowedActions: ClaimAction[] }
ApprovalTask  = { stepId; claimId; claimNumber; title; claimant: UserRef; revision; level; levelCount; tierLabel; amountMinor; currency; status; activatedAt; decidedAt }
ClaimHistory  = { submissions: { revision; submittedAt; totalMinor; lineItemCount; outcome: SubmissionOutcome; snapshot: SnapshotV1; steps: ClaimDetail['approval']['steps'] }[];
                  events: { id; type; occurredAt; actor: UserRef; actorRole; revision; fromStatus; toStatus; reason; payload; requestId }[] }
```

Wire formats: instants UTC ISO-8601 with `Z`; calendar dates `YYYY-MM-DD`; money integer minor units (JSON safe integers). `data-testid` hooks used by Playwright: `claim-status`, `claim-number`, `saved-total`, `unsaved-total`, `timeline-event` (with `data-event-type`).

### C-11 Environment variables

One `.env` (copied from `.env.example`) feeds compose interpolation and host-side commands. **No compose service uses `env_file`.** Each service receives only the variables in its column.

| Variable | `.env.example` value | postgres | objectstore | migrate | app | host |
|---|---|---|---|---|---|---|
| `APP_ENV` | `local` | | | ✓ | ✓ | ✓ |
| `APP_BASE_URL` | `http://localhost:3000` | | | | ✓ | ✓ |
| `APP_PORT` | `3000` | | | | (publish) | |
| `APP_VERSION` | `dev` | | | | ✓ | |
| `LOG_LEVEL` | `info` | | | ✓ | ✓ | ✓ |
| `DATABASE_URL` | `postgresql://expense_app:<DB_APP_PASSWORD>@localhost:5432/expense_claims` | | | | ✓ (compose: host `postgres`, built from `DB_APP_PASSWORD`) | ✓ (`pnpm dev`) |
| `DB_POOL_MAX` | `10` | | | | ✓ | ✓ |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `60` | | | | ✓ | ✓ |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | `12` | | | | ✓ | ✓ |
| `DEMO_MODE` | `true` | | | | ✓ | ✓ |
| `RECEIPT_STORAGE_DRIVER` | `s3` (`s3 | fs | memory`) | | | ✓ (from P6: `ensure-bucket` is a no-op for `fs`) | ✓ | ✓ |
| `RECEIPT_FS_DIR` | `./.data/receipts` (fs driver only) | | | | ✓ | ✓ |
| `S3_ENDPOINT` | `http://localhost:8333` | | | ✓ (compose: `http://objectstore:8333`) | ✓ (same) | ✓ |
| `S3_REGION` | `us-east-1` | | | ✓ | ✓ | ✓ |
| `S3_BUCKET` | `receipts` | | | ✓ | ✓ | ✓ |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `local-demo-access-key` / `local-demo-secret-key-change-me` | | ✓ (as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) | ✓ | ✓ | ✓ |
| `EXPORT_BATCH_SIZE` | `500` | | | | ✓ | ✓ |
| `NEXT_TELEMETRY_DISABLED` | `1` | | | | ✓ | ✓ |
| `POSTGRES_DB` | `expense_claims` | ✓ | | (in URL) | (in URL) | |
| `POSTGRES_USER` | `postgres` | ✓ | | | | |
| `POSTGRES_PASSWORD` | `local-superuser-pw-change-me` | ✓ **only** | | | **forbidden** | |
| `DB_OWNER_PASSWORD` | `local-owner-pw-change-me` | ✓ (initdb) | | (in URL) | **forbidden** | |
| `DB_APP_PASSWORD` | `local-app-pw-change-me` | ✓ (initdb) | | | (in URL only; var **forbidden**) | |
| `MIGRATE_DATABASE_URL` | `postgresql://expense_owner:<DB_OWNER_PASSWORD>@localhost:5432/expense_claims` | | | ✓ (compose: host `postgres`) | **forbidden** | ✓ (`prisma` CLI) |
| `SHADOW_DATABASE_URL` | *(optional, commented)* | | | | **forbidden** | ✓ |
| `PERF_DATABASE_URL` | `postgresql://expense_owner:<DB_OWNER_PASSWORD>@localhost:5432/expense_perf` | | | | | ✓ (`pnpm perf:seed`, `perf:explain`; core P7) |
| `SEED_ON_START` | `true` | | | ✓ | | |
| `SEED_DEMO_PASSWORD` | `DemoOnly!2026` | | | ✓ | **forbidden** | ✓ (Playwright) |
| `POSTGRES_HOST_PORT` | `5432` | (publish 127.0.0.1) | | | | |
| `S3_HOST_PORT` | `8333` | | (publish 127.0.0.1) | | | |
| `E2E_BASE_URL` | `http://localhost:3000` | | | | | ✓ |

"Forbidden" = the app exits on boot when `NODE_ENV=production` and the variable is set (D-34). Role names `expense_owner` / `expense_app` are fixed constants, not env. OPTIONAL variables: `S3_PUBLIC_ENDPOINT`, `RECEIPT_UPLOAD_URL_TTL_SECONDS=120`, `RECEIPT_DOWNLOAD_URL_TTL_SECONDS=60` (§8); `EXPORT_MAX_CONCURRENT=2`; `LOGIN_RATE_LIMIT_IP=20`, `LOGIN_RATE_LIMIT_ACCOUNT=5`; `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`. Host-only, not in `.env.example`: `TEST_PG_SUPERUSER_URL` (external-DB mode of the integration harness, D-42) and `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` (set only by the user, to let an AI agent run `prisma migrate reset`). Removed for good: `AUTH_SECRET`, `AUTH_*`, `APP_TIMEZONE`, `BUSINESS_TIMEZONE`, `APP_CURRENCY`, `DEFAULT_CURRENCY`, `DATABASE_URL_MIGRATE`, `DATABASE_OWNER_URL`, `APP_URL`, `TEST_DATABASE_URL` (Testcontainers builds URLs), `DB_OWNER_USER`, `DB_APP_USER`.

### C-12 Pinned versions

Runtime/toolchain: Node **24.21.0** (`.nvmrc`; local 24.13.1 must be upgraded), pnpm **10.34.6** (`packageManager`), Docker Engine 29.8 / Compose v5.5.

| Package | Version | | Package | Version |
|---|---|---|---|---|
| `next` | **16.4.0 → 16.4.x OOB patch on 14 Oct 2026** | | `typescript` | 6.0.3 |
| `react`, `react-dom`, `@types/react`, `@types/react-dom` | 19.3.0 | | `@types/node` | 24.19.1 |
| `@next/env`, `eslint-config-next` | = `next` | | `eslint` | 9.39.5 |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | 7.10.0 | | `typescript-eslint` | 8.71.0 |
| `pg`, `@types/pg` | 8.23.1 | | `eslint-config-prettier` | 10.1.8 |
| `zod` | 4.6.5 | | `prettier` / `prettier-plugin-tailwindcss` | 3.9.9 / 0.8.1 |
| `@tanstack/react-query` | 5.104.1 | | `vitest`, `@vitest/coverage-v8` | 5.0.3 |
| `react-hook-form` | 7.89.0 | | `vite` | 8.3.4 |
| `@hookform/resolvers` | 5.9.1 | | `@vitejs/plugin-react` / `vite-tsconfig-paths` | 6.1.1 / 6.1.1 |
| `@aws-sdk/client-s3` | 3.1145.0 | | `jsdom` | 30.1.1 |
| `@aws-sdk/s3-request-presigner` (§8 only) | 3.1145.0 | | `@testing-library/react` / `dom` / `user-event` / `jest-dom` | 16.3.3 / 10.4.2 / 14.6.7 / 7.0.1 |
| `pino` | 10.4.0 | | `testcontainers`, `@testcontainers/postgresql` | 12.2.0 |
| `pino-pretty` (dev, piped) | 13.1.3 | | `@playwright/test` | 1.63.0 |
| `server-only` | 0.0.1 | | `tsx` | 4.23.15 |
| `tailwindcss`, `@tailwindcss/turbopack` (loader in `next.config.ts`; no PostCSS) | 4.3.3 | | `fast-check` (OPTIONAL) | 4.10.2 |
| shadcn/ui companions (`lucide-react`, `sonner`, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `class-variance-authority` 0.7.1, `tw-animate-css` 1.4.0) | as installed by `shadcn init`, then pinned | | `husky` / `lint-staged` (OPTIONAL) | 9.1.7 / 17.6.0 |

Not used: `csv-stringify`, `date-fns`, `nuqs`, `@node-rs/argon2`, `better-auth`, `next-auth`, `jose`/`openid-client` (Entra = ADR only). Never upgrade Prisma to ≥ 8 or TypeScript to ≥ 7 without an ADR.

Images (digest-pinned in P0; bump tag and digest together): `node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66`, `postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336` (compose and Testcontainers use the same digest), `chrislusf/seaweedfs:4.48`, `grafana/k6:2.3.0` (OPTIONAL), `mcr.microsoft.com/playwright:v1.63.0-noble` (OPTIONAL CI).

Fallbacks decided in P0: standalone build → `nodeLinker: hoisted` → `next build --webpack` → non-standalone `next start`; ESM issues → generator `importFileExtension = "ts"` or drop `"type": "module"`; TS 6 trouble → 5.9.3; Vitest 5 trouble → 4.1.x. P0 needed none of them; its one ESM quirk is that `tsx` scripts must default-import `@next/env` (named `loadEnvConfig` import fails under `"type": "module"`; `prisma.config.ts` is unaffected).

### C-13 Approval thresholds (paise)

Exclusive lower bounds: a tier applies when `claim total > applies_above_minor`.

| level | code | label | `applies_above_minor` | In rupees | resolver | `levels_up` / designated | Seeded |
|---|---|---|---|---|---|---|---|
| 1 | `L1_MANAGER` | Line manager | 0 | > ₹0.00 (every claim) | `REPORTING_LINE` | 1 | active |
| 2 | `L2_SKIP_LEVEL` | Skip-level manager | 1,000,000 | > ₹10,000.00 | `REPORTING_LINE` | 2 | active |
| 3 | `L3_SENIOR_LEADER` | Senior leader | 5,000,000 | > ₹50,000.00 | `REPORTING_LINE` | 3 | active |
| 4 | `L4_CFO` | CFO | 20,000,000 | > ₹2,00,000.00 | `DESIGNATED_USER` | `deepa.menon@acme.test` | **inactive** (§8 demo: `pnpm policy:activate-tier L4_CFO`) |

| Claim total | Steps (T4 inactive) | Steps (T4 active) |
|---|---|---|
| ₹0.01 – ₹10,000.00 | 1 | 1 |
| ₹10,000.01 – ₹50,000.00 | 2 | 2 |
| ₹50,000.01 – ₹2,00,000.00 | 3 | 3 |
| > ₹2,00,000.00 (cap ₹1,00,00,000.00) | 3 | 4 |

### C-14 Policy constants (`src/shared/policy.ts`)

```ts
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const CURRENCY = 'INR';
export const MAX_LINE_ITEMS = 50;
export const MIN_LINE_AMOUNT_MINOR = 1;
export const MAX_LINE_AMOUNT_MINOR = 100_000_000;     // ₹10,00,000.00
export const MAX_CLAIM_TOTAL_MINOR = 1_000_000_000;   // ₹1,00,00,000.00
export const MIN_EXPENSE_DATE = '2000-01-01';
export const TITLE_LENGTH = { min: 3, max: 120 };
export const DESCRIPTION_LENGTH = { min: 3, max: 500 };
export const MERCHANT_MAX = 120;
export const REJECT_REASON_LENGTH = { min: 10, max: 1000 };
export const APPROVE_COMMENT_MAX = 1000;
export const RECALL_NOTE_MAX = 500;
export const RECEIPT_MAX_BYTES = 10_485_760;          // 10 MiB
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_RECEIPTS_PER_LINE = 5;
export const EXPORT_MAX_RANGE_DAYS = 366;
export const EXPORT_SETTLE_MINUTES = 2;
export const PAGE_LIMIT = { default: 25, max: 100 };
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
```

### C-15 Demo seed accounts

All `@acme.test`; password = `SEED_DEMO_PASSWORD` (`.env.example`: `DemoOnly!2026`, local demo only). Departments: `ENG` (Engineering), `FIN` (Finance), `EXEC` (Executive).

| Email | Name | Code | Dept | role | can_approve | Reports to | Purpose |
|---|---|---|---|---|---|---|---|
| `asha.rao@acme.test` | Asha Rao | E1001 | ENG | EMPLOYEE | – | ravi.menon | main claimant |
| `ravi.menon@acme.test` | Ravi Menon | E1002 | ENG | EMPLOYEE | ✓ | meera.iyer | L1 for Asha |
| `meera.iyer@acme.test` | Meera Iyer | E1003 | ENG | EMPLOYEE | ✓ | vikram.shah | L2 for Asha |
| `vikram.shah@acme.test` | Vikram Shah | E1004 | EXEC | EMPLOYEE | ✓ | — | L3 for Asha; top of hierarchy |
| `deepa.menon@acme.test` | Deepa Menon | E1005 | FIN | EMPLOYEE | ✓ (`is_fallback_approver`) | vikram.shah | CFO: fallback approver and L4 designated user |
| `neha.kapoor@acme.test` | Neha Kapoor | E1006 | ENG | EMPLOYEE | ✓ | meera.iyer | approver **outside Asha's chain** (sharpest-test actor) |
| `arjun.das@acme.test` | Arjun Das | E1007 | ENG | EMPLOYEE | – | neha.kapoor | owner of claims routed to Neha |
| `farah.khan@acme.test` | Farah Khan | E1008 | FIN | FINANCE | – | deepa.menon | finance: read-all + export; never routed |
| `admin@acme.test` | Site Admin | E1009 | EXEC | ADMIN | – | — | config only; no extra visibility |

Expected chains (asserted by tests): Asha ₹8,000 → [ravi]; ₹10,000.00 → [ravi]; ₹10,000.01 / ₹25,000 → [ravi, meera]; ₹75,000 → [ravi, meera, vikram]; ₹2,50,000 → [ravi, meera, vikram] (T4 inactive) / [ravi, meera, vikram, deepa] (T4 active). Arjun ₹5,000 → [neha]; ₹25,000 → [neha, meera]. Ravi ₹75,000 → [meera, vikram, deepa (FALLBACK)]. Vikram ₹8,000 → [deepa (FALLBACK)]; Vikram ₹25,000 → **422 `ROUTING_UNRESOLVABLE`** (L2: no second-level manager, fallback already in chain — deliberate fixture). Farah ₹3,000 → [deepa].

Categories (code / name / GL): `TRAVEL_AIR` Air travel 6101; `TRAVEL_RAIL` Rail travel 6102; `LOCAL_TRANSPORT` Local transport 6103; `LODGING` Hotels & lodging 6110; `MEALS` Meals 6120; `CLIENT_ENTERTAINMENT` Client entertainment 6130; `OFFICE_SUPPLIES` Office supplies 6200; `INTERNET_PHONE` Internet & phone 6210; `TRAINING` Training & courses 6300; `MISC` Miscellaneous 6900; **inactive** `LEGACY_PER_DIEM` Per diem (retired) 6199.

Demo claims (seeded via services with `SeedClock`; IST times):

| Id | Owner | State | Story |
|---|---|---|---|
| C01 | Asha | DRAFT rev 0 | "Team lunch", 1 line ₹1,200 |
| C02 | Asha | SUBMITTED rev 1, PENDING ravi | ₹8,000, 1 step — **the out-of-queue target for Neha** |
| C03 | Asha | SUBMITTED rev 1, L1 approved, PENDING meera | ₹25,000, 2 steps |
| C04 | Asha | APPROVED rev 1 (3 steps) on 2026-09-15 | ₹75,000 — the locked-claim demo |
| C05 | Asha | REJECTED rev 1 by ravi | ₹12,000, reason "Hotel invoice missing for 3 Oct" |
| C06 | Asha | SUBMITTED rev 2, PENDING ravi | rev 1 ₹30,000 rejected by meera; resubmitted at ₹9,500 (chain 2 → 1) |
| C07 | Asha | DRAFT rev 1 (recalled after ravi approved L1 of 2) | recall demo |
| C08 | Arjun | SUBMITTED rev 1, PENDING neha | ₹5,000 — foreign to Ravi |
| C09 | Arjun | APPROVED at 2026-09-30 23:59:30 IST | September boundary |
| C10 | Asha | APPROVED at 2026-10-01 00:15:00 IST | October boundary |
| C11 | Vikram | SUBMITTED rev 1, PENDING deepa (FALLBACK) | fallback demo |
| C12 | Farah | APPROVED by deepa | finance user as a claimant |

### C-16 Privilege matrix (`expense_app`)

| Object | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `users` | ✓ | – | – | – |
| `departments`, `categories`, `approval_policy_tiers` | ✓ | – | – | – |
| `sessions` | ✓ | ✓ | ✓ | ✓ |
| `claims` | ✓ | ✓ | ✓ | ✓ (trigger: never-submitted drafts only) |
| `line_items` | ✓ | ✓ | ✓ | ✓ |
| `receipts` | ✓ | ✓ | – | ✓ |
| `claim_submissions` | ✓ | ✓ | – | – |
| `approval_steps` | ✓ | ✓ | ✓ | – |
| `claim_events` | ✓ | ✓ | – | – |
| `export_runs` (OPTIONAL) | ✓ | ✓ | ✓ (trigger-guarded) | – |
| `v_claim_total_drift` | ✓ | | | |
| `claim_number_seq` | USAGE, SELECT | | | |
| `_prisma_migrations` | – | – | – | – |

Also: no TRUNCATE, TRIGGER or REFERENCES on anything; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE TEMPORARY ON DATABASE expense_claims FROM PUBLIC`; `GRANT CONNECT ON DATABASE expense_claims TO expense_app`; `GRANT USAGE ON SCHEMA public TO expense_app`. `01-roles.sh` (superuser, first boot) creates both roles, sets `expense_app` role timeouts, makes `expense_owner` the owner of `expense_claims` and schema `public`, sets `ALTER DATABASE expense_claims SET timezone TO 'UTC'`, and applies the database-level REVOKEs; table grants live in migrations.

### C-17 Docker and compose names

- Compose services: `postgres` (`postgres:18.6-trixie@sha256:…` per C-12, volume `pgdata:/var/lib/postgresql`, `./docker/postgres/initdb:/docker-entrypoint-initdb.d:ro`, healthcheck over TCP `pg_isready -h 127.0.0.1 -p 5432 …` so it can't report healthy while initdb's socket-only server is still running `01-roles.sh`, `127.0.0.1:${POSTGRES_HOST_PORT}:5432`); `objectstore` (from P6; `chrislusf/seaweedfs:4.48`, `weed mini`, volume `objectstore:/data`, healthcheck, `127.0.0.1:${S3_HOST_PORT}:8333`; removed or moved under `profiles: ["s3"]` if the FS fallback is chosen); `migrate` (build target `tools`, command `release`, depends on `postgres` healthy, plus `objectstore` healthy from P6 unless the FS fallback is chosen); `app` (build target `runner`, depends on `migrate: service_completed_successfully`, `127.0.0.1:${APP_PORT}:3000`, `init: true`, `stop_grace_period: 20s`, healthcheck on `/api/health/ready`); `k6` (profile `load`, OPTIONAL).
- Dockerfile targets: `base`, `deps`, `build` (runs `mkdir -p public` before `next build`), `runner`, `tools`. Tools entrypoint `docker/tools/entrypoint.sh` subcommands: `migrate`, `seed`, `ensure-bucket`, `release`.
- Files: `compose.yaml`, `Dockerfile`, `.dockerignore` (excludes `.env*`, `node_modules`, `.next`, tests), `docker/postgres/initdb/01-roles.sh`, `scripts/ensure-bucket.ts`.

### C-18 Folder layout and module names

```
src/
  app/layout.tsx (<Providers>: QueryClient, Toaster)  app/not-found.tsx  app/global-error.tsx   # no root page.tsx (the scaffold's is deleted)
  app/(auth)/login/page.tsx
  app/(app)/layout.tsx  (app)/page.tsx (→ /claims)  (app)/error.tsx  claims/…  approvals/…  finance/…   # pages: shell + client components only
  app/api/v1/**/route.ts                                         # defineRoute handlers only
  app/api/health/{live,ready}/route.ts
  proxy.ts                                                       # optimistic page redirect only
  instrumentation.ts                                             # env() → forbidden vars → assertRuntimeRole() → assertPolicyLoadsWellFormed() (P3); exit 1 on failure
  server/env.ts
  server/db/{client.ts (getDb, PrismaPg), tx.ts (withTx, type Tx), pg-error.ts (readSqlState), introspection.ts (readRoleAttributes, countDisabledTriggers, ping, readinessProbe)}
  server/http/{define-route.ts (ROUTE_META), public-routes.ts, request-context.ts (AsyncLocalStorage), csrf.ts, call-meta.ts (callMeta(req) → { ip, userAgent }: sessions.user_agent + access log)}
  server/auth/{session.ts (createSession, authenticate), password.ts, cookie.ts (sessionCookieName), rsc.ts (getActor), actor.ts, runtime-role.ts (assertRuntimeRole)}
  server/authz/claim-policy.ts                                   # pure decide(), allowedActions, submissionOutcome
  server/errors/{codes.ts, app-error.ts, map-error.ts}
  server/routing/{build-chain.ts, policy.ts (assertPolicyWellFormed, assertPolicyLoadsWellFormed), org-loader.ts}
  server/audit/{events.ts (Zod union), record-event.ts}
  server/services/{context.ts (ServiceCtx, SeedClock), claims.service.ts, lifecycle.service.ts, approvals.service.ts, receipts.service.ts, finance.service.ts, export.service.ts, auth.service.ts, health.service.ts}   # signatures: C-26
  server/repositories/{claim-visibility.ts (claimVisibilityWhere, findClaimForActor), claims.repo.ts (lockOwnedClaim, lockClaimRoutedToMe), line-items.repo.ts, receipts.repo.ts, submissions.repo.ts, steps.repo.ts, events.repo.ts, users.repo.ts, sessions.repo.ts, categories.repo.ts, tiers.repo.ts, export.repo.ts}
  server/storage/{receipt-storage.ts, s3-receipt-storage.ts, memory-receipt-storage.ts, fs-receipt-storage.ts, sniff.ts}
  server/export/{csv.ts, export-stream.ts}
  server/logging/logger.ts
  shared/{enums.ts, errors.ts, policy.ts, money.ts, dates.ts, cursor.ts, schemas/*, dto/*}
  features/{claims,approvals,finance,auth}/…   components/…   lib/{api-client.ts (apiFetch, ApiError), query-keys.ts, use-url-query.ts}
  generated/prisma/                                              # gitignored
prisma/{schema.prisma, migrations/, seed.ts, seed-personas.ts (seedReference, seedReferenceAndCast, restoreReference), seed-claims.ts (seedDemoClaims)}
prisma.config.ts  next.config.ts (Tailwind via @tailwindcss/turbopack; no postcss.config.mjs)  vitest.config.mts  eslint.config.mjs
tests/{unit, integration, component, helpers/{global-setup.ts, integration-setup.ts, db.ts, http.ts, auth.ts, factories.ts, route-manifest.ts, empty-module.ts}}
e2e/{auth.setup.ts, *.spec.ts}
scripts/{ensure-bucket.ts, verify-integrity.ts, policy-activate-tier.ts, perf/{seed-perf.ts, explain.ts}, demo/*.sh}
docs/{design/0N-*.md, adr/000N-*.md, perf/*.txt, walkthrough.md, demo-script.md, runbook.md}
load/export.k6.js                                                # OPTIONAL
```

`package.json` scripts (contract): `dev`, `dev:pretty`, `build`, `start`, `typecheck`, `lint`, `format`, `format:check`, `db:generate`, `db:migrate:dev`, `db:deploy`, `db:seed`, `db:reset`, `db:diff-check`, `test`, `test:unit`, `test:int`, `test:component`, `test:e2e`, `verify` (generate + typecheck + lint + format:check + unit + component + integration), `verify:integrity`, `policy:activate-tier`, `perf:seed`, `perf:explain`, `compose:up`, `compose:down`, `compose:reset`. `verify:integrity`, `policy:activate-tier`, `perf:seed` and `perf:explain` run as `tsx --conditions=react-server scripts/…` (they import `server-only` modules) and first call `nextEnv.loadEnvConfig(process.cwd())` (default import of `@next/env`). The owner scripts `policy:activate-tier` and `perf:seed` then set `process.env.DATABASE_URL` to the owner URL (`MIGRATE_DATABASE_URL`, or `PERF_DATABASE_URL` for `perf:seed`; exit 1 if unset) **before** dynamically importing any `src/server` module. `perf:explain` runs its "after" plans **as `expense_app` on `expense_perf`**, like the app: it requires `DATABASE_URL` to be the `expense_app` URL and rebinds it to the perf database before importing any `src/server` module; only its "before" plans, which drop an index inside `BEGIN … ROLLBACK`, run as the owner through `PERF_DATABASE_URL` (exit 1 if either URL is missing). `verify:integrity` reads the view with the app's `DATABASE_URL`. `db:reset` wraps `prisma migrate reset`, which Prisma 7.10 refuses to run under an AI agent unless the user explicitly consents (`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`); agents ask the user instead of setting it.

### C-19 Log event names

`app.boot`, `app.shutdown`, `http.request`, `auth.login.succeeded`, `auth.login.failed`, `auth.logout`, `authz.denied`, `claim.created`, `claim.updated`, `claim.deleted`, `claim.submitted`, `claim.resubmitted`, `claim.step_approved`, `claim.approved`, `claim.rejected`, `claim.recalled`, `receipt.uploaded`, `receipt.deleted`, `receipt.object_orphaned`, `export.started`, `export.completed`, `export.failed`, `db.backstop` (with `defense: 'db'`, `sqlstate`). Standard fields: `level`, `time`, `service`, `env`, `version`, `requestId`, `userId`, `route`, `event`, plus event-specific fields (`claimId`, `revision`, `durationMs`, `status`, `rows`).

### C-20 Audit event catalogue

One event per state-changing request, written by `recordEvent(tx, ctx, event)`; typed columns + Zod-validated `payload`.

| `type` | Request | `from → to` | `actor_role` / `actor_id` | `step_id` | `reason` | `payload` |
|---|---|---|---|---|---|---|
| `CLAIM_SUBMITTED` | submit from DRAFT (rev 1, or after recall) | DRAFT → SUBMITTED | CLAIMANT / claimant | – | – | `{ lineItemCount, chain: [{ level, tierCode, approverId, resolvedVia }], previousRevision?: { revision, totalMinor, outcome } }` |
| `CLAIM_RESUBMITTED` | submit from REJECTED | REJECTED → SUBMITTED | CLAIMANT / claimant | – | – | same as above, `previousRevision` required |
| `STEP_APPROVED` | approve, non-final level | SUBMITTED → SUBMITTED | APPROVER / step approver | ✓ | approve comment | `{ level, levelCount, tierCode, nextApproverId }` |
| `CLAIM_APPROVED` | approve, final level | SUBMITTED → APPROVED | APPROVER / step approver | ✓ | approve comment | `{ level, levelCount, tierCode, approverIds }` |
| `CLAIM_REJECTED` | reject at any level | SUBMITTED → REJECTED | APPROVER / step approver | ✓ | rejection reason (required) | `{ level, levelCount, tierCode, cancelledStepIds }` |
| `CLAIM_RECALLED` | recall | SUBMITTED → DRAFT | CLAIMANT / claimant | – | recall note | `{ cancelledSteps: [{ stepId, level, approverId, wasStatus }], approvedLevelsVoided }` |

Every event also stores `claim_id`, `submission_id`, `revision`, `total_minor` (the submission total), `request_id`, `tx_id`, `occurred_at`. Not audited: draft creation/edits/deletion, receipt changes on editable claims (captured by the next snapshot; logged). OPTIONAL: `STEP_REASSIGNED` (reassign endpoint; added via `ALTER TYPE … ADD VALUE`).

### C-21 Submission snapshot JSON v1

```jsonc
{
  "v": 1,
  "claimant": { "id": "…", "employeeCode": "E1001", "name": "Asha Rao", "email": "asha.rao@acme.test", "departmentCode": "ENG" },
  "title": "Client visit Pune",
  "currency": "INR",
  "totalMinor": 2500000,
  "lines": [
    { "lineItemId": "…", "expenseDate": "2026-10-03", "categoryId": "…", "categoryCode": "LODGING", "categoryName": "Hotels & lodging", "glCode": "6110",
      "amountMinor": 840000, "description": "Hotel, 2 nights", "merchant": "Hotel Blue",
      "receipts": [ { "receiptId": "…", "fileName": "invoice.pdf", "contentType": "application/pdf", "sizeBytes": 183422, "sha256": "…", "storageKey": "receipts/…" } ] }
  ]
}
```

Lines ordered by `expense_date, id`. The DB verifies `lines[*]` against live `line_items` on `(lineItemId, amountMinor, categoryId, expenseDate)` and `Σ amountMinor = total_minor = claims.total_minor` (UC016).

### C-22 CSV export columns

One row per line item, in this order (header row uses these names): `claim_number`, `claim_id`, `revision`, `employee_code`, `employee_name`, `employee_email`, `department_code`, `claim_title`, `submitted_at` (ISO, `+05:30`), `approved_at` (ISO, `+05:30`), `posting_date` (approval date in IST, `YYYY-MM-DD`), `final_approver_email`, `line_no` (1-based in snapshot order), `line_item_id`, `expense_date`, `category_code`, `category_name`, `gl_code`, `description`, `merchant`, `amount` (decimal string from minor units, e.g. `8400.00`), `currency`, `claim_total` (decimal string), `receipt_count`. Generated (written raw): ids, numbers, dates, amounts, `gl_code`, `currency`, `revision`, `line_no`, `receipt_count`. Through `csvText()`: every name, email, title, description, merchant, category name, department code. Empty period → header-only file, 200.

### C-23 Migrations

| Folder (timestamp prefix by Prisma) | Contents | Phase |
|---|---|---|
| `…_init` | enums (`user_role`, `claim_status`), `departments`, `users`, `sessions`, `categories`, `claims`, `line_items`, indexes; **prepended** `claim_number_seq` + `next_claim_number()` | P0 |
| `…_integrity_core` | functions #1–#5 (`assert_claim_editable` v1, `claims_guard` v1), CHECKs, `v_claim_total_drift` | P0 |
| `…_privileges` | grants/revokes for P0 tables, sequence, view (explicit, no default privileges), then the appended schema re-assert `REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO expense_app;` ([03 §16.4](./03-data-model-and-integrity.md#164-migration-3-privileges-p0)) | P0 |
| `…_workflow` | Prisma part: enums (`approval_step_status`, `approver_resolver`, `claim_event_type`, `event_actor_role`), `approval_policy_tiers`, `claim_submissions`, `approval_steps`, `claim_events`, the `current_submission_id` FK, partial indexes. Hand-written block in [03 §16.5](./03-data-model-and-integrity.md#165-migration-4-workflow-p3) order: the workflow CHECKs; **#1 `assert_claim_editable` v2** (`CREATE OR REPLACE`, snapshot freeze, BUG-2); #6 `claim_submissions_verify` v1; #7; #8; #9; #4 `claims_guard` v2 (`CREATE OR REPLACE`); triggers; grants | P3 |
| `…_receipts` | `receipts` + composite FK; function #10 `receipts_before_write` + trigger; **#6 `claim_submissions_verify` v2** (`CREATE OR REPLACE`: the v1 text with the three edits in [03 §16.6](./03-data-model-and-integrity.md#166-migration-5-receipts-p6), written out in full in the migration — without it every submit of a claim with a receipt fails with UC016 → 500); grants | P6 |
| `…_export_runs` (OPTIONAL) | `export_run_status`, `export_runs`, immutability trigger, grants | BUF |
| `…_receipt_upload_intents` (OPTIONAL-§8) | `receipt_status`, receipts status columns, adjusted trigger | BUF |

### C-24 Phases and calendar

**Calendar:** days, dates, the per-day budget and the gate times live **only** in [PLAN §4–§5](../../PLAN.md#4-phase-wise-plan). This table holds each phase's scope and exit gate; when PLAN moves a phase between days, nothing here changes.

| Phase | Scope | Exit gate |
|---|---|---|
| **P0** Walking skeleton + integrity spike | toolchain; scaffold (Tailwind 4 via `@tailwindcss/turbopack`); Prisma 7; migrations `init` / `integrity_core` / `privileges` (+ schema re-assert); roles script; digest-pinned Dockerfile; compose (`postgres`, `migrate`, `app`); health routes; `introspection.ts`; `readSqlState`; Testcontainers harness (+ external-DB mode). The object-store probe moved to the P6 storage gate and the CI workflow to P8. Landed early in P0: `eslint.config.mjs` + TC-U10, TC-I07/TC-I08 for the P0 tables, a draft `ci.yml` | spike tests (a)–(e) and TC-I06 green; `compose up --build --wait` healthy, image built with no `.env`; drift rule clean (D-37) and `migrate dev --create-only` twice empty. Then the Plan B gate (D-13) |
| **P1** Identity + request spine | Next OOB patch; env + boot checks; pino + ALS; `defineRoute` (health routes re-wrapped as `auth: 'public'`); errors/codes/map; sessions + login/logout/me; CSRF; seed personas/categories (`seedReference()` + cast; tiers in P3); `seedReferenceAndCast` / `restoreReference` for tests; ESLint boundaries + TC-U10 (already in P0); login page + shell + proxy + api-client (root layout renders `<Providers>`; scaffold `page.tsx` replaced) | TC-I01 (against the phase's route manifest) to TC-I05, TC-U08, TC-U10, TC-U11 green; login → shell |
| **P2** Draft claims + total integrity | shared money/dates/schemas; categories; claims create/get/list API/PUT/delete (C-25 order minus the receipt-key steps, which P6 adds); visibility predicate (owner + finance) and `findClaimForActor` (C-26); `decide()`; factories `makeDraft`/`makeUser`; `ClaimForm` editor UI; desync + concurrency + privileges + schema-objects + validation tests; **TC-I17 first form** (owner-scoped) | integrity suite (TC-I12, TC-I13) + the TC-I17 first form green |
| **P3** Submit, routing, audit | migration `workflow` (incl. #1 v2, #6 v1; C-23); tiers seed (L1–L3 active, L4_CFO inactive) inside `seedReference()`; `assertPolicyLoadsWellFormed()` as boot step 4; `buildChain`; submit/resubmit; `recordEvent`; `ctx.clock` passed through createClaim, replaceClaim, submit and `recordEvent`; `policy:activate-tier`; chain stepper UI; routing tests incl. T4 activation; TC-I23 submit case | TC-U03, TC-I15 and the P3 cases of TC-I16 green (its level-activation case lands in P4, its stored-approvers case in P5); L4 activation gives a 4-step chain with no code change; clean `compose up` still healthy |
| **P4** Approver queue + decisions (authz slice) | `/approvals` API + UI (Pending/Decided tabs, From/To IST date inputs) on the shared list component, reused for `/claims`; TC-C01; visibility for routed/decided approvers; approve/reject ladder (+ `ctx.clock`); `approveAs`/`rejectAs`/`ownerDecideAt` fixtures (TC-I25 IST boundaries); review UI; TC-I17 routed-approver form; TC-I18 over fixture F1 {GET, PUT, DELETE, submit, approve, reject}; TC-I19; TC-I20 parallel approvals; TC-I25 | TC-I17 (bar the history, recall and receipt rows) + TC-I18 (F1) green |
| **P5** Reject, recall, resubmit, history, lock proof | recall (+ `ctx.clock`); resubmit from REJECTED; history endpoint; `lastRejection`; banners + raw event list; locked-approved suite (TC-I11 bar its receipt cases); TC-I18 recall/history columns + fixture F2; TC-I20 approve-vs-recall race; TC-I21, TC-I22; `scripts/demo/*.sh` | those tests green; C09/C10 `approved_at` in IST read 2026-09-30 23:59:30 and 2026-10-01 00:15:00; clean `compose up` healthy |
| **P6** Receipts | storage gate (SeaweedFS or the FS adapter, 30-min timebox); objectstore + ensure-bucket (or the FS recipe, 01 §11.3); `ReceiptStorage` (S3/Memory/FS) + magic-byte sniffer; migration `receipts` (#10 + #6 v2); upload/download/delete; receipt-key retention steps added to `replaceClaim` and `deleteDraft` (D-31); UI; receipt cases of TC-I11/TC-I14/TC-I17/TC-I22. Planned in two slots (PLAN) | TC-I27 green against the chosen driver |
| **P7** Finance list + streamed export + EXPLAIN | finance list + detail (plain table); export stream + page; perf seed (`--claims 10000`, [07 §12.1](./07-testing.md#121-the-generator-scriptsperfseed-perfts-pnpm-perfseed)) + EXPLAIN evidence | TC-U06, TC-U09, TC-I26, TC-I28 green; `docs/perf/*.txt` show Index Scan with no Sort |
| **P8** Evidence + hardening | Playwright TC-E00/E01/E02/E04/E06 (CORE), E03/E05 if on time; CI workflow; clean-clone rehearsal (incl. the README prerequisites); README §6 table + interpretation decisions; 8 ADRs; walkthrough/demo/runbook; graceful-shutdown check | `pnpm verify` + core e2e green; e2e gate: if red, drop TC-E03 and keep E01, E02, E04, E06 |
| **BUF** Buffer | slips first (P6, then the perf seed); demo rehearsal; then OPTIONAL in order: RR export + `export_runs` → §8 signed URLs → 50k/100k generator + k6 → OTel | slips closed; demo rehearsed |

Cut order when behind: (1) all §8/OPTIONAL items; (2) Playwright reject→resubmit (TC-E03); (3) finance list UI polish, (4) receipts UI polish and (5) the timeline UI (render raw events) are **already applied** in the plan; (6) the CI workflow (run `pnpm verify` locally). **Never cut** any §6 item: validation tests, specific failure codes, the auth inventory (TC-I01) and the page-redirect test (TC-E04), the sharpest test, the desync test, keyset/streamed filtering, audit events, `docker compose up` with only `.env`.

### C-25 Service write orders (the DB triggers depend on these)

All inside `withTx`; the claim lock is always first.

- **PUT replace-set:** `lockOwnedClaim` → status (APPROVED → `CLAIM_LOCKED`; SUBMITTED → `CLAIM_NOT_EDITABLE`) → existing ids; foreign id → `LINE_ITEM_NOT_FOUND` → category existence/active → collect receipt keys of removed lines → `deleteMany` → `updateMany` per kept row (`WHERE id AND claim_id`, count 1) → `createMany` → title → re-read DTO. After commit: if `current_revision = 0`, delete removed objects (on failure log `receipt.object_orphaned`); log `claim.updated`. The two receipt-key steps need the `receipts` table and `ReceiptStorage`, so P2 builds this order without them and P6 adds them.
- **Submit:** `lockOwnedClaim` → status (APPROVED → `CLAIM_LOCKED`; SUBMITTED → `INVALID_STATUS_TRANSITION`) → load lines (0 → `NO_LINE_ITEMS`; inactive category → `CATEGORY_INACTIVE`) → load active tiers + org (recursive CTE) → `buildChain` (→ `ROUTING_UNRESOLVABLE`) → INSERT `claim_submissions` (revision = current + 1, snapshot) → INSERT `approval_steps` (level 1 PENDING, rest WAITING, tier copies, `resolved_via`) → UPDATE `claims` (status SUBMITTED, `current_revision`, `current_submission_id`) → `recordEvent(CLAIM_SUBMITTED | CLAIM_RESUBMITTED)`.
- **Approve:** role gate before tx → `lockClaimRoutedToMe` (none → diagnose: decided current revision → `ALREADY_DECIDED`, else `NOT_IN_YOUR_QUEUE`) → re-read my PENDING step on `current_submission_id` (none → same diagnosis) → `revision` check (`REVISION_MISMATCH`) → UPDATE step → APPROVED (+ comment; `WHERE status = 'PENDING'`, count 1) → next level exists ? UPDATE it WAITING → PENDING : UPDATE claim → APPROVED → `recordEvent(STEP_APPROVED | CLAIM_APPROVED)`.
- **Reject:** as approve up to the revision check → UPDATE step → REJECTED (+ `rejection_reason`) → UPDATE remaining WAITING steps → CANCELLED → UPDATE claim → REJECTED → `recordEvent(CLAIM_REJECTED)`.
- **Recall:** `lockOwnedClaim` → status (APPROVED → `CLAIM_LOCKED`; not SUBMITTED → `INVALID_STATUS_TRANSITION`) → UPDATE current submission's PENDING/WAITING steps → CANCELLED → UPDATE claim → DRAFT → `recordEvent(CLAIM_RECALLED)`.
- **Delete draft:** `lockOwnedClaim` → APPROVED → `CLAIM_LOCKED`; `current_revision > 0` → `CLAIM_HAS_HISTORY` → collect receipt keys → DELETE claim (cascades lines + receipts) → after commit delete objects (on failure log `receipt.object_orphaned`). The receipt-key steps arrive in P6, as for PUT.
- After every commit: domain log line with the same `requestId`. Never call storage or any network inside a transaction.
- Timestamps: when `ctx.clock` is set (owner-run seed only), each write above that touches a DB-owned timestamp passes `ctx.clock.now()` ([02 §9](./02-domain-and-workflow.md#9-service-sketches)); otherwise it passes nothing and the DB stamps `now()` (D-23).

### C-26 Repository and service signatures

One set of names and shapes, used verbatim by 02, 04, 07 and PLAN.

```ts
// src/server/services/context.ts  (services, defineRoute, the seed and the test factories import it;
//                                   services never import @/server/http/*)
export interface SeedClock { now(): Date }                       // semantics: 02 §9
export interface ServiceCtx { actor: Actor; requestId: string; clock?: SeedClock }

// src/server/repositories/claim-visibility.ts  (no tx: reads through getDb(), after commit)
export function claimVisibilityWhere(actor: Actor): Prisma.ClaimWhereInput;
export function findClaimForActor<S extends Prisma.ClaimSelect>(actor: Actor, claimId: string, select: S)
  : Promise<Prisma.ClaimGetPayload<{ select: S }> | null>;      // null = refused at the point of the query

// src/server/repositories/claims.repo.ts  (inside withTx; the first statement of every mutation)
export function lockOwnedClaim(tx: Tx, actor: Actor, claimId: string): Promise<LockedClaim | null>;      // claimant_id = me
export function lockClaimRoutedToMe(tx: Tx, actor: Actor, claimId: string): Promise<LockedClaim | null>; // my PENDING step, FOR NO KEY UPDATE OF c
```

- **Repositories return `null`; services throw.** A `null` from `lockOwnedClaim` becomes 404 `CLAIM_NOT_FOUND`; a `null` from `lockClaimRoutedToMe` goes through the `ALREADY_DECIDED` / `NOT_IN_YOUR_QUEUE` diagnosis ([C-25](#c-25-service-write-orders-the-db-triggers-depend-on-these)). There is no `lockClaimRoutedToMe` in `steps.repo.ts` and no tx-taking `findClaimForActor`.
- **Every service function is `(ctx: ServiceCtx, ...ids, input?)`.** Claim mutations return the fresh `ClaimDetail`, re-read through `findClaimForActor` after commit (`deleteDraft` returns nothing):

| Module | Functions |
|---|---|
| `claims.service.ts` | `createClaim(ctx, input)`, `getClaim(ctx, claimId)`, `replaceClaim(ctx, claimId, input)`, `deleteDraft(ctx, claimId)` |
| `lifecycle.service.ts` | `submit(ctx, claimId, input?)`, `recall(ctx, claimId, input?)` |
| `approvals.service.ts` | `approve(ctx, claimId, input)`, `reject(ctx, claimId, input)` (+ the queue list) |
| `receipts.service.ts` | `upload(ctx, claimId, lineItemId, file)` (+ download and delete) |

- `ServiceCtx` is built by `defineRoute` from the authenticated actor and the request id; tests build it as `` { actor, requestId: `test-${randomUUID()}` } ``; only the owner-run seed adds `clock`.

