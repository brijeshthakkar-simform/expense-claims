
**P0 spike (state after 0001–0003, claims_guard v1)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| P0-a | PASS | app role raw UPDATE claims SET total_minor raises UC003 | UC003: TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written |
| P0-b | PASS | line UPDATE / INSERT / DELETE on a SUBMITTED claim raises UC002 (v1 submit = status flip + revision/pointer bump) | UC002: CLAIM_NOT_EDITABLE: claim EXP-2026-000002 is in approval; recall it to edit |
| P0-c | PASS | owner disables the recompute trigger inside a tx; COMMIT fails UC009; trigger is enabled again | UC009: TOTAL_MISMATCH: claim EXP-2026-000003 stores 100 but its line items sum to 1099 |
| P0-d | PASS | app role cannot DISABLE TRIGGER, TRUNCATE or SET session_replication_role (42501) | 42501: permission denied to set parameter "session_replicati / 42501: must be owner of table line_items / 42501: permission denied for table line_items |
| P0-e | PASS | two connections inserting lines into one claim serialize and the total is 300 | T2 waited on Lock/transactionid; final total 300 |
| P0-f | PASS | v1 refuses DRAFT -> APPROVED (UC005) and a zero-line submit (UC004) | UC004: NO_LINE_ITEMS: claim EXP-2026-000 / UC005: INVALID_STATUS_TRANSITION: DRAFT  |

**Prisma schema ↔ migrations consistency**

| ID | Result | Test | Evidence |
|---|---|---|---|
| PR-1 | PASS | prisma migrate diff: live DB (after deploy) → schema.prisma is empty | exit 0 (no difference) |
| PR-2 | PASS | prisma migrate diff: migrations folder (replayed in a shadow DB) → schema.prisma is empty | exit 0 (no difference; shadow replay of all 5 migrations incl. hand SQL succeeded) |
| PR-3 | PASS | P0 exit criterion: `prisma migrate dev --create-only` (owner; Prisma auto-creates its shadow DB via CREATEDB) finds no drift and generates an EMPTY migration, twice | run 1: "-- This is an empty migration." \| run 2: "-- This is an empty migration." |

**a. claim total always equals SUM(line items)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| A1 | PASS | insert one line → total = amount |  |
| A2 | PASS | multi-row INSERT (createMany shape) → one recompute, total = sum |  |
| A3 | PASS | UPDATE amount; UPDATE description only; UPDATE all lines of a claim |  |
| A4 | PASS | DELETE one line; DELETE all lines → 0 |  |
| A5 | PASS | PUT replace-set in ONE transaction (deleteMany → updateMany → createMany → title) → total = sum |  |
| A6 | PASS | INSERT … ON CONFLICT DO UPDATE (upsert) → total = sum |  |
| A7 | PASS | MERGE (update + delete + insert in one statement) → total = sum |  |
| A8 | PASS | COPY line_items FROM STDIN as the app role → triggers fire, total = sum |  |
| A9 | PASS | total over the ₹1 crore cap fails closed (23514); int4 overflow fails closed (22003); claim unchanged | 23514: new row for relation "claims" violates check constraint "claims \| 22003: integer out of range |
| A10 | PASS | DELETE a never-submitted draft with lines (and a receipt) → cascades cleanly |  |
| A11 | PASS | sabotage: owner disables the recompute trigger and inserts a line → COMMIT fails UC009, trigger re-enabled | UC009: TOTAL_MISMATCH: claim EXP-2026-000011 stores 100 but its line items sum to 150 |
| A12 | PASS | INSERT claims with total_minor ≠ 0 → UC003 (app and owner) | UC003: TOTAL_IS_DERIVED: a claim is created with total_minor = 0; the total is derived from its line items |

**b. direct writes of claims.total_minor are rejected (UC003)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| B1 | PASS | app: UPDATE claims SET total_minor = 1 → UC003 | UC003: TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written |
| B2 | PASS | owner: same UPDATE → UC003 (the guard is not privilege-based) | UC003: TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written |
| B3 | PASS | CTE trick: WITH (INSERT line) UPDATE claims SET total_minor → UC003 | UC003: TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written |
| B4 | PASS | a custom GUC grants no authority: set_config(app.recalc, on) then UPDATE → UC003 | UC003: TOTAL_IS_DERIVED: total_minor is computed from line items and cannot be written |
| B5 | PASS | writing total_minor on a SUBMITTED or APPROVED claim → UC003 / UC001 | UC003: TOTAL_IS_DERIVED: total \| UC001: CLAIM_LOCKED: claim EXP |

**c. moving a line to another claim is rejected (UC010)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| C1 | PASS | app: UPDATE line_items SET claim_id = other draft → UC010; both totals intact | UC010: IMMUTABLE_FIELD: a line item cannot move to another claim |
| C2 | PASS | owner: same move → UC010 | UC010: IMMUTABLE_FIELD: a line item cannot move to another claim |
| C3 | PASS | moving a receipt to another line or claim → UC010 (owner; the app has no UPDATE on receipts → 42501) | 42501: permission denied for table recei \| UC010: IMMUTABLE_FIELD: a receipt cannot |

**d. concurrency under READ COMMITTED (two+ app connections, real interleavings)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| D1 | PASS | T1 insert, T2 insert (blocks), T1 commit, T2 commit → total = sum, no UC009/deadlock | T2 waited (Lock/transactionid); total 300 |
| D2 | PASS | T1 insert, T2 insert (blocks), T1 ROLLBACK → T2 proceeds; total = T2 only |  |
| D3 | PASS | concurrent UPDATE vs DELETE of the SAME line: T1 update, T2 delete (blocks), T1 commit, T2 commit | T2 waited (Lock/transactionid); line deleted; total 1000 |
| D4 | PASS | concurrent DELETE (T1) vs UPDATE (T2) of the same line → T2 updates 0 rows; total consistent |  |
| D5 | PASS | concurrent UPDATE of different lines of one claim → serialized on the claim; total = sum |  |
| D6 | PASS | insert vs submit — line insert first: submit waits, then snapshots the new line too |  |
| D7 | PASS | insert vs submit — submit first: the line insert waits, then fails UC002 (claim now SUBMITTED) | UC002: CLAIM_NOT_EDITABLE: claim EXP-2026-000031 is in approval; recall it to edit |
| D8 | PASS | storm: 12 connections × 25 random insert/update/delete transactions on 3 claims → no drift, no UC009, no deadlock | 300 transactions, 0 errors, drift empty |
| D8b | PASS | same storm WITHOUT the claim-first lock (raw multi-row UPDATE/DELETE): deadlocks / lock or statement timeouts roll victims back; never UC009, the total never drifts | errors {"40P01":48,"55P03":4} out of 200 tx, never UC009, drift empty — why services lock the claim row first (D-14; D8 had 0 errors) |
| D9 | PASS | opposite-order multi-claim writers (raw SQL; services never do this) → PG detects the deadlock (40P01), the survivor commits, totals consistent | outcomes 40P01, ok; the service-layer retry (40P01 ×2) would re-run the loser |
| D10 | PASS | double-click approve: two connections approve the same PENDING step → exactly one decision, other sees 0 rows | rowCounts 0, 1 |
| D11-approve | PASS | approve (L1 of 2) vs recall, approve queued first → serialized: both succeed in order (recall is legal until the final approval); L1 kept in history | final DRAFT; steps APPROVED/CANCELLED |
| D11-recall | PASS | approve (L1 of 2) vs recall, recall queued first → serialized: approve finds no PENDING step (NOT_IN_YOUR_QUEUE); nothing approved | final DRAFT; steps CANCELLED/CANCELLED |
| D11-final | PASS | FINAL approve vs recall race (1-step chain), approve queued first → recall loses: DB refuses SUBMITTED-only transition on an APPROVED claim (UC001) | exactly one wins; the service maps this to 409 CLAIM_LOCKED before reaching the DB |
| D12 | PASS | lock wait beyond lock_timeout → 55P03 (maps to 409 CONFLICT); role default is 5s, shortened here to 300ms | 55P03: canceling statement due to lock timeout |

**e. APPROVED is immutable (UC001); SUBMITTED content is frozen (UC002)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| E1 | PASS | APPROVED: INSERT / UPDATE / DELETE line → UC001 | UC001: CLAIM_LOCKED: claim EXP-2026-000044 is approved and read-only |
| E2 | PASS | APPROVED: INSERT / DELETE receipt → UC001 | UC001: CLAIM_LOCKED: claim EXP-2026-000044 is approved and read-only |
| E3 | PASS | APPROVED: UPDATE title / status / approved_at, DELETE claim → UC001 | UC001: CLAIM_LOCKED: claim EXP-2026-000044 is approved and read-only |
| E4 | PASS | APPROVED: new submission (resubmit an approved claim) → UC001 | UC001: CLAIM_LOCKED: claim EXP-2026-000044 is approved and read-only |
| E5 | PASS | APPROVED: owner gets the same UC001 (DB rule, not a privilege) | UC001: CLAIM_LOCKED: claim EXP-2026-000044 is approved and read-only |
| E6 | PASS | SUBMITTED: line INSERT / UPDATE / DELETE, receipt INSERT, title UPDATE → UC002; DELETE claim → UC017 | UC002: CLAIM_NOT_EDITABLE: claim EXP-2026-000045 i \| UC017: CLAIM_HAS_HISTORY: claim EXP-2026 |
| E7 | PASS | snapshot freeze: after the submission row is inserted (claim still DRAFT) line/receipt writes → UC002 | UC002: CLAIM_NOT_EDITABLE: claim EXP-2026-000046 is being submitted; its snapshot is already taken |
| E8 | PASS | REJECTED and recalled (DRAFT rev ≥ 1) claims are editable again |  |

**f. a claim with zero line items cannot be submitted (UC004)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| F1 | PASS | service submit of an empty draft → UC004 (from the snapshot insert) | UC004: NO_LINE_ITEMS: a submission needs at least one line item |
| F2 | PASS | raw status flip to SUBMITTED with zero lines → UC004 (claims_guard) | UC004: NO_LINE_ITEMS: claim EXP-2026-000050 has no line items |
| F3 | PASS | empty snapshot for a claim that has lines → UC004 | UC004: NO_LINE_ITEMS: a submission needs at least one line item |
| F4 | PASS | delete the last line inside the submit transaction → blocked by the freeze (UC002), never an empty submission | UC002: CLAIM_NOT_EDITABLE: claim EXP-2026-000052 is being submitted; its snapshot is already taken |

**g. audit trail: append-only, DB-stamped, complete (UC007 / UC015)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| G1 | PASS | app: UPDATE / DELETE claim_events → 42501; owner → UC007 | 42501: permission denied for table claim_even \| UC007: APPEND_ONLY: claim_events rows cannot  |
| G2 | PASS | claim_submissions: app UPDATE/DELETE → 42501; owner → UC007 | 42501: permission denied for table claim_submissions |
| G3 | PASS | approval_steps: app DELETE → 42501; owner DELETE → UC007 | UC007: APPEND_ONLY: approval steps are never deleted |
| G4 | PASS | app-supplied occurred_at / tx_id are overwritten by the DB (no backdating, no cross-tx attribution) | stored occurred_at=2026-10-13 13:15:41.954+00, tx_id=2058 |
| G5 | PASS | status change without an event (recall) → COMMIT fails UC015; nothing persisted | UC015: AUDIT_EVENT_MISSING: claim EXP-2026-000055 moved SUBMITTED -> DRAFT without a matching CLAIM_RECALLED event by |
| G6 | PASS | decision whose event names another actor → UC015 (actor must be the step approver) | UC015: AUDIT_EVENT_MISSING: step 01a13567-900b-7ec7-ac04-c268f0d243a7 became APPROVED without a matching event by its |
| G7 | PASS | submit whose event names a non-claimant actor → UC015 | UC015: AUDIT_EVENT_MISSING: claim EXP-2026-000057 moved DRAFT -> SUBMITTED without a matching CLAIM_SUBMITTED event b |
| G8 | PASS | non-final approval (STEP_APPROVED) without an event → UC015 (step-level audit) | UC015: AUDIT_EVENT_MISSING: step 01a13567-9015-7edd-af0e-5c43d1946cd8 became APPROVED without a matching event by its |
| G9 | PASS | an event committed in an EARLIER transaction does not satisfy a later transition → UC015 | UC015: AUDIT_EVENT_MISSING: claim EXP-2026-000059 moved SUBMITTED -> DRAFT without a matching CLAIM_RECALLED event by |
| G10 | PASS | event type must match the transition (CLAIM_SUBMITTED for a resubmit from REJECTED) → UC015 | UC015: AUDIT_EVENT_MISSING: claim EXP-2026-000060 moved REJECTED -> SUBMITTED without a matching CLAIM_RESUBMITTED ev |
| G11 | PASS | BY DESIGN: the app role may INSERT a stand-alone event (C-16); it is DB-stamped and immutable but changes no state | inserted event 01a13567… (accepted residual RT-M2: identity is proven by the scoped query, not the DB) |
| G12 | PASS | happy path writes exactly one event per state-changing request |  |

**h. the app role cannot switch the guards off**

| ID | Result | Test | Evidence |
|---|---|---|---|
| H1 | PASS | SET session_replication_role = replica → 42501 | 42501: permission denied to set parameter "session_replication_role" |
| H2 | PASS | ALTER TABLE … DISABLE TRIGGER (ALL / one / USER) → 42501 on every guarded table | 42501: must be owner of table line_items |
| H3 | PASS | TRUNCATE (line_items, claims, claim_events, claim_submissions) → 42501 | 7 tables refused |
| H4 | PASS | CREATE TABLE / FUNCTION / VIEW in public, CREATE SCHEMA, CREATE TEMP TABLE (shadowing) → 42501 | permission denied for schema public / permission denied for schema public / permission denied for schema public / permission denied for database expense_claims / permissi |
| H5 | PASS | SET ROLE expense_owner / postgres → 42501; ALTER ROLE self SUPERUSER → 42501; GRANT to self has no effect |  |
| H6 | PASS | identity / reference / policy tables are read-only for the app (self-promote to FINANCE, re-point a manager, collapse tiers) → 42501 | 42501: permission denied for table departments |
| H7 | PASS | exhaustive privilege matrix (C-16): every relation in public, every privilege | 13 relations match; sequence, database and schema privileges match |
| H8 | PASS | role attributes: app is not superuser/createdb/createrole/bypassrls, NOINHERIT, owns nothing, not in expense_owner; timeouts set |  |

**i. state machine and approval-step gating**

| ID | Result | Test | Evidence |
|---|---|---|---|
| I1 | PASS | DRAFT → APPROVED / REJECTED (raw) → UC005 | UC005: INVALID_STATUS_TRANSITION: DRAFT -> APPROVED is not allowed |
| I2 | PASS | APPROVED → DRAFT / SUBMITTED / REJECTED → UC001 (terminal) |  |
| I3 | PASS | REJECTED → APPROVED / DRAFT → UC005 | UC005: INVALID_STATUS_TRANSITION: REJECTED -> DRAFT is not allowed |
| I4 | PASS | SUBMITTED → APPROVED while a step is still PENDING/WAITING (with a matching event) → UC011 | UC011: APPROVAL_INCOMPLETE: claim EXP-2026-000064 still has steps that are not approved |
| I5 | PASS | SUBMITTED → REJECTED without a REJECTED step → UC011 | UC011: APPROVAL_INCOMPLETE: a rejection needs a rejected step and no open steps |
| I6 | PASS | under-approval: ₹75,000 claim submitted with a 1-step chain → UC012 | UC012: CHAIN_INVALID: claim EXP-2026-000066 needs 3 approval level(s) for total 7500000; the chain has 1 step(s) (2 b |
| I7 | PASS | exclusive thresholds in SQL: ₹10,000.00 → 1 step OK; ₹10,000.01 with 1 step → UC012; with 2 → OK |  |
| I8 | PASS | chain shape: tier copy forged (wrong tier_code / threshold) → UC012; level 2 inserted PENDING → UC012 | UC012: CHAIN_INVALID: level 1 starts PENDING, later levels start WAITING, nothing is decided yet |
| I9 | PASS | step inserted outside a submit (claim already SUBMITTED) → UC012 | UC012: CHAIN_INVALID: approval steps are created only by a submit, for the claim's newest submission |
| I10 | PASS | ineligible approver at insert: the claimant, a FINANCE user, an inactive user → UC008 | UC008: APPROVER_NOT_ELIGIBLE: an approver is active, can approve, is not Finance and is not the claimant |
| I11 | PASS | eligibility re-checked at decision time: approver demoted mid-chain (can_approve=false, or role FINANCE) → UC008 | UC008: APPROVER_NOT_ELIGIBLE: the approver is no longer eligible to decide this step |
| I12 | PASS | step gating: WAITING → APPROVED → UC005; WAITING → PENDING before the previous level is approved → UC012 | UC005: INVALID_STATUS_TRANSITION: step W \| UC012: CHAIN_INVALID: a level activates  |
| I13 | PASS | decided steps are immutable: edit comment / re-decide an APPROVED step → UC006 | UC006: ALREADY_DECIDED: approval step 01a13567-8ff3-7056-ac8f-fc8d529a16a7 is already APPROVED |
| I14 | PASS | open step identity / timestamps immutable: re-point approver_id, backdate activated_at → UC010 | UC010: IMMUTABLE_FIELD: an open step changes only through a status transition |
| I15 | PASS | recall leaving an open step (claim → DRAFT with PENDING step) → UC012 | UC012: CHAIN_INVALID: cancel the open approval steps before recalling |
| I16 | PASS | reject leaving WAITING steps open → UC011 | UC011: APPROVAL_INCOMPLETE: a rejection needs a rejected step and no open steps |
| I17 | PASS | submission revision / submitter forged → UC016 | UC016: SNAPSHOT_MISMATCH: the next revision is 1, not 2 |
| I18 | PASS | forged snapshot (amount, extra/missing line, GL code, category name, claimant, title, receipt key) → UC016 | 9 forgeries refused; the honest snapshot (with its receipt) is accepted (rev 1) |
| I19 | PASS | claim pointed at ANOTHER claim's submission → UC012; step pointing at another claim's submission → UC012 (and the composite FK behind it) | UC012: CHAIN_INVALID: a submit points at \| UC012: CHAIN_INVALID: approval steps are created only by a s |
| I20 | PASS | happy path ₹75,000: submit → 3 steps [ravi, meera, vikram] → approve ×3 → APPROVED; DB-stamped timestamps |  |
| I21 | PASS | reject → REJECTED (rest CANCELLED) → edit → resubmit (rev 2) builds a NEW chain from the new total; rev-1 history intact |  |
| I22 | PASS | recall after L1 approved (of 2) → open steps CANCELLED, L1 stays APPROVED; claim DRAFT rev 1; edit; resubmit rev 2 |  |
| I23 | PASS | DELETE: never-submitted draft OK; recalled draft (rev ≥ 1) → UC017 | UC017: CLAIM_HAS_HISTORY: claim EXP-2026-000084 was submitted and cannot be deleted |
| I24 | PASS | routing fixtures (C-15) hold against the DB chain check: Ravi ₹75k → [meera, vikram, deepa FALLBACK]; Vikram ₹8k → [deepa FALLBACK]; T4 activation → 4 steps |  |

**j. other rules canonical.md says the database enforces**

| ID | Result | Test | Evidence |
|---|---|---|---|
| J1 | PASS | expense_date after today in Asia/Kolkata → UC014; today (IST) accepted; also on UPDATE | UC014: EXPENSE_DATE_IN_FUTURE: 2026-10-14 is after today in Asia/Kolkata (today IST = 2026-10-13) |
| J2 | PASS | inactive category on insert / on category change → UC013; an existing line keeps working | UC013: CATEGORY_INACTIVE: choose an active expense category |
| J3 | PASS | claim_number: DB-owned, EXP-YYYY-NNNNNN, consecutive for app inserts (no double draw); app-supplied value replaced | EXP-2026-000091, EXP-2026-000092, EXP-2026-000093; forged → EXP-2026-000094, EXP-2026-000095 |
| J4 | PASS | claims.created_at and the transition timestamps are DB-owned for the app (backdating ignored or UC010) | approved_at=2026-10-13 13:15:42.184+00 (app supplied 2020-01-01) |
| J5 | PASS | owner-run seed CAN supply backdated transition timestamps (SeedClock), still only at legal transitions |  |
| J6 | PASS | immutable claim columns: claimant_id, claim_number, currency, created_at → UC010; pointer moves only on submit → UC010 | UC010: IMMUTABLE_FIELD: the submission pointer moves only on submit |
| J7 | PASS | CHECK backstops (23514/23505): finance+approve, 2nd fallback, uppercase email, amount 0 / > ₹10L, short description/title, date < 2000, short reject reason | 11 CHECK / unique backstops fired |
| J8 | PASS | composite FK: a receipt whose claim_id differs from its line's claim → 23503 | 23503: insert or update on table "receipts" violates foreign key constraint "receipts_line_item_id_claim_id_fkey" |
| J9 | PASS | /api/health/ready integrity probe (as the app role): zero disabled non-internal triggers in public |  |
| J10 | PASS | schema-objects: exact trigger set per table; every public function pins search_path; contract indexes exist | 14 triggers, 11 functions, 12 contract indexes |
| J11 | PASS | one PENDING step per submission is also a partial UNIQUE index (owner bypassing the guard trigger → 23505) | 23505: duplicate key value violates unique constraint "approval_steps_one_pending_per_submission" |
| J12 | PASS | final sweep: v_claim_total_drift is empty after the whole suite |  |
| J13 | PASS | foot-gun documented: SET CONSTRAINTS ALL IMMEDIATE *before* a line write → UC009 at statement end (fail-closed); after the write it just checks early | UC009: TOTAL_MISMATCH: claim EXP-2026-000105 stores 1 but it — never call SET CONSTRAINTS in app code |
| J14 | PASS | test-reset recipe (D-42): owner TRUNCATE of the transactional tables succeeds (no row triggers), app works afterwards |  |

**Prisma 7.10 client + @prisma/adapter-pg: error shapes of the DB backstops (for readSqlState)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| PE | PASS | model op: claim.update({ totalMinor }) → readSqlState() = UC003 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC003","kind":"postgres","originalCode":"UC003","originalMessage":"TOTAL_IS_DERIVED: total_min |
| PE | PASS | model op: claim.updateMany({ totalMinor }) → readSqlState() = UC003 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC003","kind":"postgres","originalCode":"UC003","originalMessage":"TOTAL_IS_DERIVED: total_min |
| PE | PASS | $executeRaw UPDATE total → readSqlState() = UC003 | PrismaClientKnownRequestError/P2010; meta.driverAdapterError.cause={"code":"UC003","kind":"postgres","originalCode":"UC003","originalMessage":"TOTAL_IS_DERIVED: total_min |
| PE | PASS | $queryRaw (RETURNING) UPDATE total → readSqlState() = UC003 | PrismaClientKnownRequestError/P2010; meta.driverAdapterError.cause={"code":"UC003","kind":"postgres","originalCode":"UC003","originalMessage":"TOTAL_IS_DERIVED: total_min |
| PE | PASS | model op inside interactive tx → readSqlState() = UC003 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC003","kind":"postgres","originalCode":"UC003","originalMessage":"TOTAL_IS_DERIVED: total_min |
| PE | PASS | lineItem.create with amount 0 (CHECK) → readSqlState() = 23514 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"23514","kind":"postgres","originalCode":"23514","originalMessage":"new row for relation \"line |
| PE | PASS | session.create duplicate token_hash (unique) → readSqlState() = 23505 | PrismaClientKnownRequestError/P2002; meta.driverAdapterError.cause={"kind":"UniqueConstraintViolation","originalCode":"23505","originalMessage":"duplicate key value viola |
| PE | PASS | future expense date (UC014) via createMany → readSqlState() = UC014 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC014","kind":"postgres","originalCode":"UC014","originalMessage":"EXPENSE_DATE_IN_FUTURE: 209 |
| PE | PASS | lineItem.update on SUBMITTED claim (spike b) → readSqlState() = UC002 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC002","kind":"postgres","originalCode":"UC002","originalMessage":"CLAIM_NOT_EDITABLE: claim E |
| PE | PASS | lineItem.deleteMany on APPROVED claim → readSqlState() = UC001 | PrismaClientKnownRequestError/P2039; meta.driverAdapterError.cause={"code":"UC001","kind":"postgres","originalCode":"UC001","originalMessage":"CLAIM_LOCKED: claim EXP-202 |
| PE | PASS | COMMIT-time deferred UC015 (interactive tx) → readSqlState() = UC015 | DriverAdapterError/-; meta.driverAdapterError.cause=null; cause={"code":"UC015","kind":"postgres","originalCode":"UC015","originalMessage":"AUDIT_EVENT_MISSING: claim EXP |

**Bug evidence: canonical-as-written vs the verified SQL (throw-away database)**

| ID | Result | Test | Evidence |
|---|---|---|---|
| BUG-1 | PASS | canonical "claims_guard forces claim_number := next_claim_number()" + column DEFAULT next_claim_number() → every app insert burns TWO sequence values | canonical wording: EXP-2026-000002, EXP-2026-000004, EXP-2026-000006; verified: EXP-2026-000007, EXP-2026-000008 |
| BUG-2 | PASS | canonical D-18 verifies the snapshot only at INSERT: without the freeze, a line edited after the snapshot (same tx, claim still DRAFT) is submitted with a snapshot that no longer matches | committed: status SUBMITTED, snapshot says MEALS, live line says CLIENT_ENTERTAINMENT (verified SQL refuses this with UC002, tests E7/F4) |
