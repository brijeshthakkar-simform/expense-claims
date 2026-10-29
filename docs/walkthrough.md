# Walkthrough: the §7 answers, with pointers into the code

The answers to the three §7 questions and the further likely ones ([PLAN §7](../PLAN.md#7-walkthrough-prep)), each with the file and line to open and the command to run live. Line numbers are as of 2026-10-16. The 12-minute demo is in [demo-script.md](demo-script.md); the decisions behind each answer are the [ADRs](adr/).

## Before you start

```bash
cp .env.example .env && docker compose up --build --wait     # the seeded stack (C01–C12)
APW=$(sed -n 's/^DB_APP_PASSWORD=\([^ #]*\).*/\1/p' .env)     # the app role's password
PW=$(sed -n 's/^SEED_DEMO_PASSWORD=\([^ #]*\).*/\1/p' .env)   # every demo account's password

# psql AS THE APP'S OWN ROLE (expense_app), inside the compose network
psql_app() { docker compose exec -T -e PGPASSWORD="$APW" postgres psql -X -h postgres -U expense_app -d expense_claims "$@"; }

# log a persona in with curl (cookie jar per persona); no Origin header, which the CSRF rule allows
login() { jq -n --arg e "$1@acme.test" --arg p "$PW" '{email:$e,password:$p}' |
  curl -s -o /dev/null -w "login $1: %{http_code}\n" -c "/tmp/$1.jar" -H 'content-type: application/json' --data @- http://localhost:3000/api/v1/auth/login; }
claim_id() { psql_app -At -c "SELECT id FROM claims WHERE claim_number = '$1'"; }
```

Migration files are abbreviated below:

| Short name | File |
|---|---|
| `init.sql` | `prisma/migrations/20261013090000_init/migration.sql` |
| `integrity_core.sql` | `prisma/migrations/20261013091000_integrity_core/migration.sql` |
| `privileges.sql` | `prisma/migrations/20261013092000_privileges/migration.sql` |
| `workflow.sql` | `prisma/migrations/20261016090000_workflow/migration.sql` (holds the current `claims_guard`, line 550) |
| `receipts.sql` | `prisma/migrations/20261021090000_receipts/migration.sql` |

---

## §7 Q1: How does the chain know which approver is next? What if the amount changes mid-chain?

**In one line:** the chain is data. It is computed once at submit and stored as rows, so "next" is simply the next row.

| Step | Where | What happens |
|---|---|---|
| 1 | `src/app/api/v1/claims/[claimId]/submit/route.ts:13` | `defineRoute` → `lifecycleService.submit(ctx, claimId)` |
| 2 | `src/server/services/lifecycle.service.ts:85` | `lockOwnedClaim`: `FOR NO KEY UPDATE` on *my* claim (404 otherwise); `:87–94` status check under the lock |
| 3 | `lifecycle.service.ts:97–98` | lines re-read after the lock; zero lines → 422 `NO_LINE_ITEMS` |
| 4 | `lifecycle.service.ts:113–115` | the active tiers (`src/server/repositories/tiers.repo.ts:27`), `assertPolicyWellFormed`, and the reporting lines (`src/server/routing/org-loader.ts:33` → the recursive CTE at `src/server/repositories/users.repo.ts:81–96`) |
| 5 | `lifecycle.service.ts:118` → `src/server/routing/build-chain.ts:58` | the pure `buildChain`. **The whole routing rule is `build-chain.ts:68–70`**: active tiers whose `applies_above_minor` the total exceeds, sorted by level |
| 6 | `build-chain.ts:96–120` | per tier: the primary (`levels_up`-th manager or designated user), then the primary's managers upward (`ESCALATED`), then the fallback approver (`FALLBACK`) |
| 7 | `build-chain.ts:126–139` | eligible = active, `can_approve`, not FINANCE, not the claimant, not already in this chain; nobody → `:87–91` 422 `ROUTING_UNRESOLVABLE`, nothing written |
| 8 | `lifecycle.service.ts:121–134` | the `claim_submissions` row for revision N+1 and its snapshot |
| 9 | `lifecycle.service.ts:137` → `src/server/repositories/steps.repo.ts:17` | the chain as `approval_steps` rows: level 1 PENDING, the rest WAITING; each step copies its tier code, label and threshold |
| 10 | `lifecycle.service.ts:140–147`, `:173` | claim → SUBMITTED, then one `CLAIM_SUBMITTED` (or `CLAIM_RESUBMITTED`) event, same transaction |
| 11 | `src/server/services/approvals.service.ts:74–75` | on approve: lock via my PENDING step, then the conditional update `steps.repo.ts:134–145` (`WHERE id AND approver_id = me AND status = 'PENDING'`, count must be 1) |
| 12 | `approvals.service.ts:87–95` | **next = level n+1**: flip it WAITING → PENDING and write `STEP_APPROVED`; no next level → `:98–106` claim APPROVED + `CLAIM_APPROVED` |
| 13 | `steps.repo.ts:292–321` | an approver's queue is just `approver_id = me AND status = 'PENDING'` on the partial index `approval_steps_pending_queue_idx` (`workflow.sql:103`) |

**Database backstops:** `claims_guard` refuses → SUBMITTED unless the steps match the active tiers for that total exactly (`workflow.sql:686–710`, UC012). `approval_steps_guard` refuses WAITING → PENDING unless the previous level is APPROVED (`workflow.sql:429–435`), and re-checks eligibility at insert (`:362–367`) and at decision time (`:437–444`, UC008).

**Amount changes mid-chain: it can't change in place.**
- While SUBMITTED, `decide()` turns EDIT into 409 `CLAIM_NOT_EDITABLE` (`src/server/authz/claim-policy.ts:45`; used at `src/server/services/claims.service.ts:141`) with `hint: RECALL_TO_EDIT` (`claim-policy.ts:77`). The DB says the same thing to raw SQL: `assert_claim_editable` raises UC002 with `HINT = 'RECALL_TO_EDIT'` (`workflow.sql:214–217`).
- The claimant recalls (`lifecycle.service.ts:200`): open steps → CANCELLED (`:230`), claim → DRAFT (`:234`), `CLAIM_RECALLED` (`:238`). APPROVED steps stay in history on that revision.
- The next submit runs steps 2–10 again: **a brand-new chain from the new total**; earlier approvals never carry over.
- A stale tab is stopped by the revision pin: `approvals.service.ts:51–55` → 409 `REVISION_MISMATCH` (`revision` is required by `ApproveInput`, `src/shared/schemas/claims.ts:148`).

**Show live:**
```bash
psql_app -c "SELECT c.claim_number, sub.revision, s.level, s.tier_code, u.email, s.status, s.resolved_via
  FROM claims c JOIN claim_submissions sub ON sub.claim_id = c.id JOIN approval_steps s ON s.submission_id = sub.id
  JOIN users u ON u.id = s.approver_id WHERE c.claim_number IN ('EXP-2026-000003','EXP-2026-000006')
  ORDER BY 1, 2, 3"                      # C03 mid-chain; C06 rev 1 (2 steps) vs rev 2 (1 step)
pnpm policy:activate-tier L4_CFO         # then Asha submits ₹2,50,000 in the UI → 4 steps, no deploy
pnpm policy:activate-tier L4_CFO --off   # restore the seeded policy
```
**Tests:** TC-U03 › "₹10,000.00 routes to 1 step", "₹10,000.01 routes to 2 steps"; TC-I16 › "only level 1 is PENDING at submit; approving level n activates n+1"; TC-I21 › "resubmitting at a higher amount builds a fresh chain from the new total (1 → 3 steps)"; TC-I19 › "stale revision returns 409 REVISION_MISMATCH".

---

## §7 Q2: An approved claim is read-only. Where is that enforced: the UI, the service or the database?

**All three, and the database is the guarantee.**

| Layer | Where | What happens |
|---|---|---|
| UI (cosmetic) | `src/features/claims/claim-detail-view.tsx:85`: `editable = allowedActions.includes('EDIT')`; `allowedActions` comes from `decide()` (`src/server/services/claim-dto.ts:102` → `claim-policy.ts:69`) | No edit, attach, remove, submit or recall controls; a locked banner |
| Service | Every mutation locks first, then asks `decide()`: PUT `claims.service.ts:139–141`; submit `lifecycle.service.ts:85–94`; recall `:210–219`; receipt upload `src/server/services/receipts.service.ts:116` and again under the lock `:129–131`. APPROVED → `claim-policy.ts:35,45` | 409 `CLAIM_LOCKED` with `details.status = 'APPROVED'` (`claim-policy.ts:76`) |
| Database | `claims_guard`: any UPDATE of an APPROVED claim (`workflow.sql:609–611`) or DELETE (`:596–600`) → UC001. `assert_claim_editable` locks the parent and raises UC001 (`workflow.sql:196–213`); it is called by `line_items_before_write` (`integrity_core.sql:78–83`) and `receipts_before_write` (`receipts.sql:54–58`) | Raw SQL, a Prisma call or a future bug all fail; `readSqlState()` (`src/server/db/pg-error.ts:59`) → `fromSqlState` (`src/server/errors/map-error.ts:59–60`) returns the same 409 `CLAIM_LOCKED` |
| Privileges | `expense_app` is `NOSUPERUSER … NOINHERIT` and owns nothing (`docker/postgres/initdb/01-roles.sh:12`); table grants are explicit (`privileges.sql:7–10`); the app refuses to boot with a privileged role (`src/server/auth/runtime-role.ts:26`, called from `src/instrumentation.ts:16`); `/api/health/ready` is 503 while an integrity trigger is disabled (`src/server/services/health.service.ts:31–47`, `src/server/db/introspection.ts:54`) | The guarantee can't be switched off from the app's own connection: `DISABLE TRIGGER`, `TRUNCATE` and `session_replication_role` → 42501 |

Why the database: it is the only layer every path crosses, including the ones nobody has written yet.

**Show live, in this order:** the UI (Asha opens C04, EXP-2026-000004: read-only, locked banner, the receipt still downloads), then
```bash
scripts/demo/edit-approved.sh   # curl as Asha: PUT, submit, recall, DELETE on C04 → 409 CLAIM_LOCKED, unchanged
scripts/demo/sql-attacks.sh     # psql as expense_app: UC001 line edit, UC001 receipt delete, UC003, 42501, 42501
```
**Tests:** TC-I11 › "every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED", "raw SQL as expense_app on an APPROVED claim raises UC001", "Prisma lineItem.update on an APPROVED claim maps to 409 CLAIM_LOCKED"; TC-I27 › "raw DELETE FROM receipts on an APPROVED claim raises UC001"; TC-I07 › "expense_app cannot DISABLE TRIGGER, TRUNCATE, or SET session_replication_role (42501)"; TC-E05 › "an approved claim renders read-only and a direct PUT returns 409 CLAIM_LOCKED".

---

## §7 Q3: Show me a rejected claim returning for edit. What is preserved and what is reset?

Demo on **C05** (EXP-2026-000005): Asha's ₹12,000 "Hyderabad site visit", rejected by Ravi at L1 with "Hotel invoice missing for 3 Oct". She edits it (it stays REJECTED, so the banner stays), then resubmits.

| Moment | Where |
|---|---|
| Ravi rejects | `approvals.service.ts:124–167`: lock via his PENDING step (`:133`), step → REJECTED with the reason (`:134`), later WAITING steps → CANCELLED (`:135`), claim → REJECTED (`:140`), `CLAIM_REJECTED` with the reason (`:141–155`). Reason rules: `src/shared/schemas/claims.ts:68` (10–1000 characters) and CHECK `steps_reason_length` (`workflow.sql:184`). The DB stamps `rejected_at` (`workflow.sql:724–732`) |
| Asha sees why | `claim-dto.ts:101` builds `lastRejection` (reason, approver, time); `src/features/claims/claim-status-banner.tsx:49` renders it in IST |
| She edits | REJECTED counts as editable (`claim-policy.ts:36,45`). `claims.service.ts:131–186` replaces the line set in one transaction; kept lines keep their ids (`:143–169`: the editor sends `lineItemId`, so edits are updates) |
| She resubmits | the same `lifecycle.service.ts:74` path: revision + 1 (`:121`), a new snapshot, **a brand-new chain** from the new total, `CLAIM_RESUBMITTED` (`:150`) carrying `previousRevision` (`:159–165`). The DB clears `rejected_at` (`workflow.sql:713`) |
| History | `GET …/history` → `claims.service.ts:116–120`: every revision with its derived outcome and chain, and every event |

| Preserved | Reset |
|---|---|
| Claim id, `claim_number`, claimant, `created_at` (immutable: `workflow.sql:614–618`, UC010) | Status: REJECTED → SUBMITTED; `rejected_at` cleared |
| The revision-1 submission and its snapshot (INSERT-only, `workflow.sql:749`) | `current_revision` + 1, with a new snapshot of the edited lines |
| Every revision-1 step with its decision, reason and timestamps (decided steps are immutable, `workflow.sql:385–388`, UC006) | A brand-new chain from the new total; prior approvals never carry over (C06: 2 steps → 1) |
| Every event, append-only (`forbid_mutation`, `workflow.sql:459`; grant SELECT+INSERT only) | Editability: frozen again while SUBMITTED |
| Receipt objects referenced by the revision-1 snapshot, even if the line is deleted (`claims.service.ts:182–183` deletes objects only for never-submitted claims) | — |

**Show live:** in the UI (demo script step 6), then the trail:
```bash
psql_app -c "SELECT e.type, e.revision, u.email AS actor, e.reason, e.request_id
  FROM claim_events e JOIN claims c ON c.id = e.claim_id JOIN users u ON u.id = e.actor_id
  WHERE c.claim_number = 'EXP-2026-000005' ORDER BY e.occurred_at, e.id"
```
Resubmitting changes the seeded data; reset with `docker compose down -v && docker compose up --build --wait`.

**Tests:** TC-I22 › "a rejected claim shows reason, approver and time to the claimant and is editable", "preserved vs reset: claim number, events, reasons and prior steps preserved; status, chain and editability reset", "events read CLAIM_SUBMITTED(r1) → CLAIM_REJECTED(r1) → CLAIM_RESUBMITTED(r2)", "receipts referenced by revision 1 stay downloadable after the line is deleted"; TC-E03 › "ravi rejects with a reason, asha edits and resubmits, and the timeline shows both revisions".

---

## Further likely questions

**1. Why store the total, if compute-on-read can't drift?** Routing, the queue, sorting and the export need the number cheaply, and an approval signs a frozen number anyway. Postgres is the only writer: the statement triggers recompute the full `SUM` (`integrity_core.sql:111–164`), `claims_guard` refuses any other write (`workflow.sql:620–624`; `pg_trigger_depth() < 2` means "not from the recompute trigger"), and `assert_claim_total_consistent` re-checks at COMMIT (`integrity_core.sql:305–352`). Compute-on-read survives as the auditor view (`integrity_core.sql:357–362`): `pnpm verify:integrity` prints 0 rows. ([ADR-0003](adr/0003-claim-total-integrity.md))

**2. Two tabs add a line to the same claim at the same moment.** Each service transaction takes `lockOwnedClaim` first (`src/server/repositories/claims.repo.ts:31–44`), and the line trigger locks the parent too (`workflow.sql:207`, `integrity_core.sql:136`), so the second writer waits. When the first commits, the second's recompute runs as a new statement with a fresh snapshot and sums both lines. TC-I13 › "a second writer waits on the claim lock (visible in pg_stat_activity) and the final total is 300".

**3. Why `FOR NO KEY UPDATE`, not `FOR UPDATE`?** A line insert's foreign-key check takes `FOR KEY SHARE` on the claim. `FOR UPDATE` conflicts with that, so two inserting transactions can deadlock while upgrading. `NO KEY UPDATE` is compatible with KEY SHARE but conflicts with itself, so writers queue (`claims.repo.ts:26–30` explains it at the call site). TC-I13 › "inserts spanning two claims in opposite order deadlock-retry without drift"; retries live in `src/server/db/tx.ts:27–45`.

**4. What stops a future developer writing `UPDATE claims SET total_minor = …`?** Four layers: strict schemas map a total-like key to 422 `TOTAL_IS_DERIVED` (`src/server/errors/map-error.ts:140`); no service writes the column (`claims.repo.ts:12`); the guard raises UC003 (`workflow.sql:620–624`); a buggy trigger is caught at COMMIT (UC009). TC-I12 › "Prisma: claim.update({ totalMinor }) is refused with UC003".

**5. What if someone disables the trigger?** The app's role can't: 42501 (`scripts/demo/sql-attacks.sh`, TC-I07). An owner who does it inside a transaction can't commit drift (TC-I12 › "owner sabotage: with the recompute trigger disabled, COMMIT fails with UC009"). A committed `DISABLE TRIGGER` takes the instance out of rotation: `/api/health/ready` → 503 (TC-I06 › "/api/health/ready returns 503 NOT_READY when an integrity trigger is disabled"). Beyond that it is a DBA action, covered by pgaudit in production.

**6. Why does a foreign claim return 404, while approving it returns 403?** Reads follow "if you can't see it, it doesn't exist": `decide()` turns owner actions into the random-id 404 (`claim-policy.ts:33–34`). Approve and reject are commands against *your queue*; anything without a PENDING step of yours, including an id that doesn't exist, gets the same 403 `NOT_IN_YOUR_QUEUE` (`approvals.service.ts:35–50`). `ALREADY_DECIDED` only goes to someone who decided the current revision and can read the claim anyway. ([ADR-0006](adr/0006-authz-404-vs-403-scoped-queries.md))

**7. Prove the refusal happens at the point of the query.** `findClaimForActor()` (`src/server/repositories/claim-visibility.ts:38–48`) AND-composes `claimVisibilityWhere(actor)` (`:19–31`) into the one SELECT; `getClaim` is a single call (`claims.service.ts:105–108`). Run `pnpm test:int tests/integration/authz/out-of-queue-by-id.int.test.ts` (about 20 s, 5 tests): it captures the SQL and checks the repository returns `null` for Neha, GET and the child routes are 404 (byte-identical to a random UUID), approve and reject are 403, and nothing changed. Live: `login neha.kapoor && curl -s -b /tmp/neha.kapoor.jar http://localhost:3000/api/v1/claims/$(claim_id EXP-2026-000002)` → 404 `CLAIM_NOT_FOUND`.

**8. How does the approver queue avoid loading every claim?** It is a query over *my steps*, never over claims (`steps.repo.ts:292–321`): `approver_id = me AND status = 'PENDING'` plus the optional IST range on `activated_at`, keyset on `(activated_at, id)`, `LIMIT n+1`, no `COUNT(*)`. The partial index (`workflow.sql:103`) holds only open work. `docs/perf/explain-queue.txt`: Index Scan using `approval_steps_pending_queue_idx` with the date range in the Index Cond and no Sort.

**9. Why keyset pagination instead of OFFSET?** OFFSET reads and discards every skipped row and shifts when rows arrive. The cursor is a position `(sortValue, id)`, encoded with the sort and a hash of the filters (`src/shared/cursor.ts:70–77`), applied as a row comparison (`steps.repo.ts:307–312`), so each page costs O(page) and pages stay complete and disjoint. `timestamptz(3)` round-trips exactly through a JS `Date`. TC-I25 › "keyset pages are complete and disjoint including ties on activated_at"; TC-U07 › "cursor issued for different filters fails with INVALID_CURSOR".

**10. How does the export stay memory-bounded, and what if it fails halfway?** `src/server/export/export-stream.ts:44–108`: a pull-based `ReadableStream` with `highWaterMark: 1` (`:107`). Each `pull()` fetches one keyset batch of 500 claims (`:58`, SQL at `src/server/repositories/export.repo.ts:64–92`) and enqueues its CSV; the next pull happens only when the client has read it. Any error calls `c.error(err)` (`:88`), so the download fails visibly (curl exits 18) instead of ending like a complete file. TC-I28 › "an injected DB error mid-stream errors the stream (no clean end)".

**11. A claim approved at 00:15 IST on 1 October: which month?** October. `businessDayRangeToUtc()` (`src/shared/dates.ts:68`) turns inclusive IST dates into `[from 00:00 IST, (to+1) 00:00 IST)` once; the export filters `approved_at` with it (`export.repo.ts:73–74`). Seed C09 (approved 23:59:30 IST on 30 Sep) and C10 (00:15 IST on 1 Oct) sit on the boundary. TC-I28 › "Sep + Oct exports equal the Sep–Oct export with no duplicates".

**12. Why can't an in-flight or rejected claim appear in the export?** The predicate is `status = 'APPROVED'` and `approved_at < asOf` (`export.repo.ts:72–74`); the DB only lets a claim become APPROVED when every step is APPROVED and stamps `approved_at` then (`workflow.sql:715–722`, UC011); APPROVED is terminal; rows come from the frozen approved snapshot. `status=REJECTED` → 422 `EXPORT_STATUS_NOT_ALLOWED` (`src/shared/schemas/queries.ts:115–122`). TC-I28 › "partially approved, rejected, draft, recalled and resubmitted-in-flight claims never appear".

**13. Why integer paise?** `0.29 * 100 === 28.999999999999996`. Amounts are integers on the wire, in TypeScript and in `int4`; input is parsed with string math (`src/shared/money.ts:29`), display passes a decimal string to `Intl.NumberFormat('en-IN')` (`money.ts:9–17`). TC-U01 › "parseMoneyToMinor('0.29') returns 29 (no float drift)"; TC-C01 › "preview total shows ₹0.30 for 0.10 + 0.20".

**14. Six months from now: who approved this, and why?** `GET …/history` (`claims.service.ts:116–120`) reads `claim_events` and `claim_submissions`. Each event is written by `recordEvent()` (`src/server/audit/record-event.ts:30–53`) in the same transaction as its state change, with the authenticated actor, from/to status, revision, step, total, reason and `request_id`. The `request_id` joins the event to that request's log lines. TC-I23 › "event request_id equals the response x-request-id", "event actor is the authenticated actor".

**15. Why not use the logs as the audit trail?** Logs are operational: sampled, rotated, and a line can describe an action that later rolled back. The audit row commits or rolls back with the change, and the DB refuses a status change without one: `assert_transition_audited` (`workflow.sql:481–540`, UC015). Log lines are written after commit (`lifecycle.service.ts:184`). TC-I23 › "a status change without an event fails at COMMIT with UC015", "a failed transition writes no event".

**16. Why can't finance approve, and where is that enforced?** Four places: CHECK `users_finance_cannot_approve` (`integrity_core.sql:11`); `buildChain` skips FINANCE (`build-chain.ts:135`); `approval_steps_guard` re-checks at insert and decision (`workflow.sql:362–367`, `:437–444`, UC008); the route role gate returns 403 `FORBIDDEN` before any query (`src/server/http/define-route.ts:108–109`, gate defined in `src/server/auth/actor.ts:24–27`). TC-I19 › "FINANCE approve/reject returns 403 FORBIDDEN", "an approver demoted to FINANCE mid-chain is refused by the DB (UC008) even if the service check is bypassed".

**17. An approver leaves, or the org chart changes, mid-chain.** The chain was materialised with fixed approver ids at submit (`steps.repo.ts:17`), "routed per the org chart as of submit". A deactivated approver's decision is refused by the DB (`workflow.sql:437–444`). The remedy today is recall + resubmit, which re-routes against current data; [runbook.md](runbook.md#stuck-approval-steps) has the query that finds these claims. A reassign endpoint is optional.

**18. Can someone approve their own claim?** No: `buildChain` skips the claimant and escalates (`build-chain.ts:136`); the guard rejects `approver_id = claimant_id` (`workflow.sql:362`, UC008); `UNIQUE(submission_id, approver_id)` (`workflow.sql:115`) stops one person signing two tiers. TC-U03 › "skips claimant, FINANCE, inactive and non-approver candidates by escalating upward".

**19. The claimant recalls or resubmits while I'm reviewing. What happens to my click?** The content can't change while SUBMITTED. After a recall I have no PENDING step → 403 `NOT_IN_YOUR_QUEUE`; after a resubmit where I'm L1 again, my stale `revision` → 409 `REVISION_MISMATCH` and the UI reloads (`approvals.service.ts:46–55`; `src/features/approvals/use-decision-errors.ts`). TC-I20 › "approve racing recall: on the final level exactly one wins; on an intermediate level both succeed in lock order; status, steps and events agree".

**20. Sessions or JWT, and how would Entra ID fit?** Opaque DB sessions (`src/server/auth/session.ts:29–76`): we hit Postgres on every request anyway, so the lookup buys instant revocation and live roles. Entra would be an OIDC code + PKCE callback that validates `iss`, `aud`, `tid`, `nonce`, maps `(tid, oid)` (never email) to a user, then calls the same `createSession()`. ([ADR-0007](adr/0007-sessions-vs-jwt-and-entra.md))

**21. Why isn't authentication in middleware or `proxy.ts`?** CVE-2025-29927 showed one header could skip Next middleware. `defineRoute` authenticates inside every handler (`define-route.ts:105`); `proxy.ts` only checks cookie presence for page redirects (`src/proxy.ts:7–12`). TC-I01 imports every `route.ts` and asserts 401 with no proxy involved, including "the x-middleware-subrequest header does not bypass authentication".

**22. Why Route Handlers, and no Server Actions or tRPC?** One deployable, one set of shared Zod schemas, one way in for Vitest, curl and Playwright. Server Actions are implicit public POST endpoints; lint bans them (`eslint.config.mjs:54–72`). Services import nothing from Next (`eslint.config.mjs:78`), so another transport could be added later. ([ADR-0001](adr/0001-single-next-app-rest-only.md), [ADR-0002](adr/0002-layering-and-import-boundaries.md))

**23. Why two database roles, and how do migrations run?** `expense_owner` owns the schema and runs only in the one-shot `migrate` container (`docker/tools/entrypoint.sh`, `release` = migrate deploy → ensure-bucket → seed). `expense_app` (`01-roles.sh:12`) has DML only. The app waits for `service_completed_successfully` (`compose.yaml`, `app.depends_on`) and refuses to boot holding owner material (`src/server/env.ts:74–81`, `src/instrumentation.ts:15`). On Azure the job is a Container Apps Job. ([ADR-0008](adr/0008-db-roles-and-migrations-as-a-job.md))

**24. Why is the line-item save one PUT of the whole set?** One request = one transaction = one commit-time total check, so a claim is never half-saved (`claims.service.ts:131–186`). Every incoming line id must belong to the path claim, which must be mine, or 404 `LINE_ITEM_NOT_FOUND` before any write (`:146–147`). TC-I14 › "PUT on my claim containing another claim's line id returns 404 LINE_ITEM_NOT_FOUND and changes nothing".

**25. How does a trigger exception become a 409 with a specific code?** Triggers `RAISE … USING ERRCODE = 'UC001'`. `readSqlState()` (`pg-error.ts:59`) reads it from Prisma's P2039/P2010 meta, a commit-time `DriverAdapterError` or a pg error; `fromSqlState()` (`map-error.ts:55–106`) maps by SQLSTATE only, never by message. Pure backstops (UC007–UC012, UC015, UC016) become a generic 500 logged with `defense: 'db'` (`map-error.ts:114`). TC-U08 › "maps every UC SQLSTATE to its catalogue code and status"; TC-I05 › "a DB-backstop error is logged at error with defense=db".

**26. Why no Row-Level Security?** The predicate already makes the database refuse the row (Q7). RLS would be a second authorization surface to keep in sync and would force every Prisma read into an interactive transaction. It is the documented next hardening step (D-46).

**27. Why receipts per line item, and why upload through the server?** A receipt proves one expense, and finance reconciles per line. The server-proxied upload (`receipts.service.ts:91–158`) enforces the 10 MiB cap before storing, checks that magic bytes match the declared type (`src/server/storage/sniff.ts:22`), records sha256, and never hands a client a write credential. Presigned uploads are the §8 step behind the same `ReceiptStorage` interface (`src/server/storage/receipt-storage.ts`). ([ADR-0004](adr/0004-lifecycle-revisions-amount-change.md))

**28. Why Prisma 7 and not 8, TypeScript 6 and not 7?** Prisma 8 is an RC without transaction isolation levels and the P2002-style codes we rely on (`tx.ts:31` sets READ COMMITTED explicitly). TypeScript 7 has no compiler API for type-aware lint yet. Versions are pinned exactly in `package.json`.

**29. The HTML page for a foreign claim returns 200. Isn't that a leak?** No. The page is a client shell with no data; `(app)/layout.tsx:13–15` reads only the signed-in user. The security-relevant response is the API's 404, which TC-E02 › "neha opening asha's claim sees the not-found view and the API returns 404" asserts.

**30. What would you change at 10× the load?** Exports from a read replica or as an async job writing to object storage; monthly partitions for `claim_events`; presigned direct-to-store uploads; OpenTelemetry into App Insights. The lists and the export already cost O(page): `docs/perf/explain-*.txt` show index range scans with no Sort on 10,000 claims, and the "before" files show what dropping each index costs.

**31. What did you deliberately not build?** RLS, Entra code, an admin UI, policy versioning, per-line endpoints, a 90-day age rule, HEIC, login throttling and a claim `version` (last write wins on a claimant's own draft, harmless because the DB derives the total). Each is a documented next step, per §8: "deepen, don't add".
