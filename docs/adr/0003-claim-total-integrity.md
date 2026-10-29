# ADR-0003: The claim total is stored, trigger-maintained and write-guarded

- **Status:** Accepted (Phase 0 spike green, 2026-10-14). Final evidence added in Phase 8 (2026-10-16).
- **Decision ids:** D-12, D-13 (Plan B, not needed), D-14 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [03 §4](../design/03-data-model-and-integrity.md#4-the-claim-total-31-4-6)

## Context

§3.1: "no code path — including a direct API call — should be able to leave a claim with a total that disagrees with the sum of its lines." §4 allows either computing the total on read or storing it and keeping it in sync, as long as it provably can't drift. Routing, the approver queue, sorting and the export all need the number cheaply, and an approval must sign a frozen number.

## Decision

Store `claims.total_minor` (integer paise) and let **only PostgreSQL** write it:

1. Three AFTER STATEMENT triggers on `line_items` (`line_items_recompute_claim_totals`, migration `20261013091000_integrity_core` lines 111–164) recompute the full `SUM` for every affected claim after INSERT, UPDATE and DELETE. They never apply deltas, so bulk `INSERT … SELECT`, `COPY` and `MERGE` are covered too.
2. `claims_guard` rejects any other change to `total_minor` (UC003), and a claim is inserted only with total 0, whichever role or code path tries.
3. A deferred constraint trigger (`assert_claim_total_consistent`) re-checks `total = SUM(lines)` at COMMIT (UC009), so even an owner who disables the recompute trigger can't commit drift.
4. Every service transaction locks the claim row first (`FOR NO KEY UPDATE`), and the line triggers lock the parent too, so concurrent writers to one claim queue instead of interleaving.
5. The app connects as `expense_app`, which owns nothing and can't disable triggers, `TRUNCATE` or change `session_replication_role` ([ADR-0008](0008-db-roles-and-migrations-as-a-job.md)).
6. Strict Zod rejects a client-sent total with 422 `TOTAL_IS_DERIVED` instead of stripping it.
7. Compute-on-read survives as the auditor: the view `v_claim_total_drift` must always be empty (`pnpm verify:integrity`).

## Consequences

- The total is indexable and cheap to read for lists, routing and the export.
- Each line write pays one `SUM` over that claim's lines (at most 50), inside the same statement.
- All integrity SQL lives in hand-written migrations; `prisma db push` and `db pull` are banned.
- The Plan B gate (switch to compute-on-read by the end of D2) was not triggered.

## Evidence

Planning-time proof on a real PostgreSQL: 127/127 checks ([reference/sql-proof](../reference/sql-proof/README.md)). Phase 0 spike on the project's own migrations, TC-I00 (`tests/integration/spike/integrity-spike.int.test.ts`):

| Case | Result |
|---|---|
| (a) app role raw `UPDATE claims SET total_minor` | UC003 |
| (b) Prisma `lineItem.update` on a SUBMITTED claim | UC002; error shape recorded for `readSqlState()` |
| (c) owner disables the recompute trigger | COMMIT fails with UC009 |
| (d) app role tries `DISABLE TRIGGER`, `TRUNCATE`, `session_replication_role` | 42501 |
| (e) two connections insert lines into one claim | serialized; total = 300 |

Final evidence:

- TC-I12 (`tests/integration/integrity/total-desync.int.test.ts`) › "no code path can leave claims.total_minor different from the sum of its line items": 12 cases, including "API: POST and PUT with totalMinor return 422 TOTAL_IS_DERIVED and persist nothing", "Prisma: claim.update({ totalMinor }) is refused with UC003", "bulk INSERT … SELECT, COPY FROM STDIN and MERGE keep total = Σ lines", "moving a line to another claim is refused with UC010", "owner sabotage: with the recompute trigger disabled, COMMIT fails with UC009" and "v_claim_total_drift is empty after every case".
- TC-I13 (`tests/integration/integrity/total-concurrency.int.test.ts`) › "a second writer waits on the claim lock (visible in pg_stat_activity) and the final total is 300", "10 parallel PUTs on one claim end with total = Σ lines", "inserts spanning two claims in opposite order deadlock-retry without drift".
- Every integration test ends with `afterEach(assertTotalsInSync)`.
- `pnpm perf:seed` loads 10,000 claims and 39,937 lines with every trigger on; drift is 0 rows (`docs/perf/seed-summary.txt`).
- Live: `pnpm verify:integrity` prints 0 rows; `scripts/demo/sql-attacks.sh` shows UC003 for a direct total write as `expense_app`.
