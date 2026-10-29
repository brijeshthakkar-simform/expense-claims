# Demo script (about 12 minutes)

The click path and commands for the RM demo, following [PLAN §6.3](../PLAN.md#63-demo-storyline-about-12-minutes-the-full-script-lives-in-docsdemo-scriptmd). Rehearse it twice from a fresh stack. The questions this demo invites are answered, with file and line pointers, in [walkthrough.md](walkthrough.md).

## Before the audience arrives (not timed)

1. Start from a clean volume, so the seeded claims get the numbers below (an e2e run adds "E2E …" claims, which is harmless but noisy):
   ```bash
   docker compose down -v && cp -n .env.example .env && docker compose up --build --wait
   ```
2. Open **<http://localhost:3000>** (never 127.0.0.1: the CSRF check compares the `Origin` with `APP_BASE_URL`). One browser window per persona keeps their cookies apart: a normal window, a private window, and a second browser profile work. Personas: **Asha**, **Ravi**, **Meera**, **Neha**, **Farah** (`<first>.<last>@acme.test`, see the [README](../README.md#demo-accounts)); every password is `SEED_DEMO_PASSWORD` from `.env.example`. The login page does not list the accounts, so keep the README table open.
3. In a terminal at the repo root, define the helpers from [walkthrough.md, "Before you start"](walkthrough.md#before-you-start) (`psql_app`, `login`, `claim_id`).
4. Open `docs/perf/explain-export-before.txt` and `explain-export-after.txt` in the editor, scrolled to the plan of Batch 2.

## Seeded data

On a fresh volume, C01–C12 are `EXP-2026-000001` … `EXP-2026-000012`. Times are IST.

| Id | Owner | Title | State | Total | Chain / story |
|---|---|---|---|---|---|
| C01 | Asha | Team lunch | DRAFT, rev 0 | ₹1,200 | Editable draft; can be deleted |
| C02 | Asha | Cab to client site | SUBMITTED | ₹8,000 | PENDING Ravi; **the claim Neha must not see** |
| C03 | Asha | Client workshop travel | SUBMITTED | ₹25,000 | Ravi APPROVED → PENDING Meera (mid-chain) |
| C04 | Asha | Annual tech conference | **APPROVED** 15 Sep 16:42:10 | ₹75,000 | Ravi → Meera → Vikram; one PDF receipt on line 1; **the locked claim** |
| C05 | Asha | Hyderabad site visit | **REJECTED** by Ravi | ₹12,000 | "Hotel invoice missing for 3 Oct"; Meera's step CANCELLED |
| C06 | Asha | Mumbai client visit | SUBMITTED, rev 2 | ₹9,500 | Rev 1 ₹30,000 rejected by Meera at L2; rev 2 has a 1-step chain (PENDING Ravi) |
| C07 | Asha | Design workshop | DRAFT, rev 1 | ₹25,000 | Recalled after Ravi approved L1 of 2 |
| C08 | Arjun | Team offsite snacks | SUBMITTED | ₹5,000 | PENDING Neha (Neha's own queue) |
| C09 | Arjun | Quarter-end client dinner | APPROVED **30 Sep 23:59:30** | ₹6,500 | By Neha; the last seconds of September |
| C10 | Asha | Home broadband, September | APPROVED **1 Oct 00:15:00** | ₹2,400 | By Ravi; the first minutes of October |
| C11 | Vikram | Board dinner cab | SUBMITTED | ₹8,000 | PENDING Deepa as **FALLBACK** (Vikram has no manager) |
| C12 | Farah | Audit courier charges | APPROVED | ₹3,000 | Finance as a claimant, approved by Deepa |

Thresholds (exclusive): L1 > ₹0, L2 > ₹10,000, L3 > ₹50,000, L4 (CFO, inactive) > ₹2,00,000.

## The script

### 1. The stack is one command (0:00–1:00)

```bash
docker compose ps                      # postgres, objectstore, app healthy; migrate "Exited (0)"
docker compose logs --no-log-prefix migrate | grep -E '^\[(tools|ensure-bucket|seed)\]'   # migrate → bucket → seed
docker compose exec app env | grep -E 'DATABASE_URL|PASSWORD|MIGRATE' | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'   # only the expense_app URL
docker compose exec app id -u          # 1000: non-root
```
Say: "`cp .env.example .env && docker compose up --build --wait` is the whole setup. The app container never sees an owner or superuser credential; migrations ran as a separate job." (TC-E06 asserts exactly this.)

### 2. Asha saves a draft; the database computes the total (1:00–2:30)

As **Asha**: **New claim** → title "Client visit Pune" → three lines, e.g. Hotels & lodging ₹8,400.00, Meals ₹1,250.50, Local transport ₹349.50 → watch the unsaved preview → **Save draft**. The URL becomes `/claims/<uuid>` and **Total (calculated by the database)** shows ₹10,000.00.

Say: "The browser never sends a total. If it did, the API would answer 422 `TOTAL_IS_DERIVED`. Postgres triggers write `total_minor`; nothing else may."

### 3. Asha submits ₹25,000; the chain is materialised (2:30–4:00)

As **Asha**: **New claim** "Delhi offsite" with Hotels & lodging ₹20,000.00 and Meals ₹5,000.00 → **Save draft** → on the claim page, **Submit**. Status "In approval · level 1 of 2"; the chain shows Ravi (PENDING) then Meera (WAITING). Open the browser dev tools on the submit request and copy its `x-request-id`.

```bash
psql_app -c "SELECT e.type, e.revision, e.request_id, e.payload->'chain' AS chain
  FROM claim_events e JOIN claims c ON c.id = e.claim_id
  WHERE c.title = 'Delhi offsite' ORDER BY e.occurred_at"
```
Say: "One typed event, written in the same transaction, with the request id from the response. The database refuses to commit a status change without it (UC015)."

*Step 3b (only if a live rejection is wanted):* Asha submits a second claim, "Pune cab", Local transport ₹1,800.00. Ravi rejects it in step 6. C05 itself has no PENDING step left.

### 4. Neha asks for Asha's claim by id (4:00–5:00)

As **Neha**: paste Asha's URL for C02 (`/claims/<C02 id>`; get it with `claim_id EXP-2026-000002`). She sees **Claim not found**, and the network tab shows `GET /api/v1/claims/<id>` → 404 `CLAIM_NOT_FOUND`, the same body as for a random UUID.

```bash
pnpm test:int tests/integration/authz/out-of-queue-by-id.int.test.ts   # TC-I17, about 20 s, 5 tests
```
Say: "The visibility predicate is inside the one SELECT. Postgres returns no row, so there is nothing to hide afterwards. Approving it would get 403 `NOT_IN_YOUR_QUEUE`."

### 5. Ravi then Meera approve; the claim locks (5:00–7:00)

As **Ravi**: **Approvals** → "Delhi offsite" → **Approve** (the dialog names Meera Iyer as next) → confirm; it leaves his queue. As **Meera**: **Approvals** → the same claim → **Approve** (the dialog says final approval). As **Asha**: reload: **Approved**, read-only, no Save or Attach.

Then the seeded locked claim C04:
```bash
scripts/demo/edit-approved.sh   # curl as Asha: PUT, submit, recall, DELETE on C04 → 409 CLAIM_LOCKED; unchanged
scripts/demo/sql-attacks.sh     # psql AS expense_app: UC001 (line edit), UC001 (receipt delete), UC003, 42501, 42501
```
Say: "The UI hides the buttons, the service answers 409, and the database refuses even raw SQL from the app's own role. The role can't switch the triggers off."

### 6. A rejected claim comes back for edit (7:00–9:00)

As **Asha**: open **C05** "Hyderabad site visit". The banner shows "Hotel invoice missing for 3 Oct", Ravi Menon and the IST time; the claim is still REJECTED and editable. Change the hotel line (or add one) → **Save & resubmit**. The status is "In approval", revision 2, with a fresh chain. Open **History**: revision 1 REJECTED (with Ravi's step and reason) and revision 2 in approval; events CLAIM_SUBMITTED → CLAIM_REJECTED → CLAIM_RESUBMITTED.

*With step 3b:* as **Ravi**, reject "Pune cab": an empty or short reason is refused (10 characters minimum); then reject with a real reason and show Asha's banner.

Say: "Nothing is overwritten: each submission is an immutable, DB-verified snapshot, decided steps can't change, and events are append-only. What resets is the status, the chain and editability."

### 7. Farah exports September and October (9:00–10:30)

As **Farah**: **Export** → **Last month** (September) → **Download CSV**; then **This month** (October) → **Download CSV**. Open both: C09 (`EXP-2026-000009`, approved 23:59:30 IST on 30 Sep) is in September; C10 (`EXP-2026-000010`, 00:15 IST on 1 Oct) and today's "Delhi offsite" are in October; nothing in flight or rejected appears. One row per line, plain decimal amounts, IST timestamps.

Then the plans, `docs/perf/explain-export-before.txt` vs `explain-export-after.txt` (10,000 claims, 24 months): before, every batch is `Sort → Seq Scan on claims`; after, the cursor batches are `Limit → Index Scan using claims_export_idx` with the keyset cursor in the Index Cond, so a mid-period batch costs the same as the first. The first September batch may show `Limit → Sort → Bitmap Heap Scan` over a `Bitmap Index Scan on claims_export_idx`: the whole month (419 claims) fits in one 500-claim batch, so the Limit cuts nothing and the planner sorts just those rows (the file marks it "bounded Sort of 419 ≤ 500 rows"). It still reads only the period through the index, never the table.

Say: "The export is a pull stream of 500-claim keyset batches. Memory depends on the batch, not the period, and a failure mid-stream fails the download instead of truncating it."

### 8. A fourth approval level with no code change (10:30–11:30)

```bash
pnpm policy:activate-tier L4_CFO
```
As **Asha**: **New claim** "Team laptops", Office supplies ₹2,50,000.00 → **Save draft** → **Submit**. The chain shows four steps: Ravi, Meera, Vikram, Deepa (CFO). Earlier claims keep their chains: each step copied its tier at submit.
```bash
pnpm policy:activate-tier L4_CFO --off   # restore the seeded policy
```

### 9. Close (11:30–12:00)

`pnpm verify:integrity` prints `v_claim_total_drift: 0 rows` after everything above. Point to the README §6 table: every §6 check, its enforcement point and the exact test name.

## After the demo

Reset the data with `docker compose down -v && docker compose up --build --wait`. If anything misbehaved, see [runbook.md](runbook.md#troubleshooting).
