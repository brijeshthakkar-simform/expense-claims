# Runbook

Operating the expense-claims stack: start, stop and reset; health and logs; the three recurring checks (stuck approval steps, orphaned receipt objects, total drift) and how to schedule the drift check in production; troubleshooting. Local commands assume the repo root and a `.env` copied from `.env.example`.

Helper used below (psql **as the app's own role**, `expense_app`, inside the compose network; it can read every table it needs here and change nothing it shouldn't):

```bash
APW=$(sed -n 's/^DB_APP_PASSWORD=\([^ #]*\).*/\1/p' .env)
psql_app() { docker compose exec -T -e PGPASSWORD="$APW" postgres psql -X -h postgres -U expense_app -d expense_claims "$@"; }
```

## Start, stop, reset

| Task | Command | Notes |
|---|---|---|
| First start / rebuild | `cp .env.example .env && docker compose up --build --wait` | Returns when `postgres`, `objectstore` and `app` are healthy and `migrate` exited 0 |
| Status | `docker compose ps -a` | `migrate` must show `Exited (0)`; the others `healthy` |
| Stop, keep data | `docker compose down` (or `docker compose stop`) | Volumes `pgdata` and `objectstore` survive |
| Start again | `docker compose up --wait` | `migrate` re-runs: pending migrations, ensure-bucket, reference data; the demo cast is **not** re-seeded while `users` has rows |
| Reset everything | `docker compose down -v && docker compose up --build --wait` | Drops both volumes: the database (re-created by `01-roles.sh` on the empty volume) and every receipt object; C01–C12 are seeded again |
| Restart only the app | `docker compose restart app` | SIGTERM (logged as `app.shutdown`): Next stops accepting connections and lets in-flight requests finish, then exits 143 (idle: under 1 s). After `stop_grace_period: 20s` Docker sends SIGKILL (exit 137), so a CSV export still streaming then is cut off and its download **fails** (curl exit 18), never a truncated success. Measured in P8: a 4,426-claim export to a slow client was killed at 20.4 s |
| Re-run the release job | `docker compose run --rm migrate` | Idempotent: `migrate deploy` → ensure-bucket → seed |
| Shell in the tools image | `docker compose run --rm --no-deps migrate sh` | Has the Prisma CLI and `tsx`; runs as the owner (`MIGRATE_DATABASE_URL`) |

Changing passwords in `.env` after the first boot does nothing to the existing roles (initdb runs only on an empty volume): reset with `down -v`.

## Health and logs

- `curl -s http://localhost:3000/api/health/live` → 200 while the process runs (no dependencies).
- `curl -s http://localhost:3000/api/health/ready | jq` → `{status, checks: {db, integrityTriggers, storage}}`. 503 `NOT_READY` when the DB is unreachable **or any integrity trigger is disabled**; `storage: degraded` is reported but keeps the instance ready (only receipts are affected).
- Logs are pino JSON on stdout: `docker compose logs -f app`. Every line of a request carries `requestId` and `userId`; every response has `x-request-id`, and error bodies repeat it as `error.requestId`. To trace a user-reported error reference: `docker compose logs app | grep '<requestId>'`.
- A state change's audit row carries the same id: `psql_app -c "SELECT type, claim_id, actor_id, occurred_at FROM claim_events WHERE request_id = '<requestId>'"`.
- Log events worth alerting on: `db.backstop` (level error, `defense: 'db'`: the database refused something the service should have refused, i.e. a code bug), `receipt.object_orphaned` (warn), `export.failed`, `authz.denied` spikes.

## Stuck approval steps

**What:** chains are frozen at submit with fixed approver ids, and the database re-checks eligibility when a step is decided (`approval_steps_guard`, UC008). If an approver is later deactivated, loses `can_approve` or becomes FINANCE, their PENDING step can never be decided and the claim waits forever. A WAITING step with such an approver will get stuck as soon as it activates. A changed reporting line does **not** make a step stuck (claims are routed per the org chart as of submit).

**Find them** (run daily, or after any org-chart or role change):

```sql
-- Open steps whose approver can no longer decide them (approval_steps_guard would raise UC008).
SELECT c.claim_number,
       c.status::text                   AS claim_status,
       s.level,
       s.tier_code,
       s.status::text                   AS step_status,
       u.email                          AS approver,
       concat_ws(', ',
         CASE WHEN NOT u.is_active          THEN 'inactive' END,
         CASE WHEN NOT u.can_approve        THEN 'cannot approve' END,
         CASE WHEN u.role = 'FINANCE'       THEN 'finance' END)  AS why,
       s.activated_at AT TIME ZONE 'Asia/Kolkata' AS pending_since_ist
  FROM public.approval_steps s
  JOIN public.claims c ON c.id = s.claim_id AND c.current_submission_id = s.submission_id
  JOIN public.users  u ON u.id = s.approver_id
 WHERE c.status = 'SUBMITTED'
   AND s.status IN ('PENDING', 'WAITING')
   AND NOT (u.is_active AND u.can_approve AND u.role <> 'FINANCE')
 ORDER BY s.status = 'PENDING' DESC, s.activated_at NULLS LAST, c.claim_number;
```

Save it as a file and run `psql_app < stuck-steps.sql`. An empty result is the healthy state.

**Fix:**
1. **Preferred:** ask the claimant to **recall** the claim (allowed until the final approval) and **resubmit** it. The new revision is routed against today's org chart, the stuck step stays in history as CANCELLED, and the audit trail records both events.
2. If the approver's ineligibility was a mistake, restore it through the owner path (a migration or owner script; `expense_app` cannot write `users`), and the step can be decided again.
3. Never edit `approval_steps` by hand: the guard refuses approver changes (UC010), and a reassign endpoint with its own audit event (`STEP_REASSIGNED`) is the planned next step.

## Orphaned receipt objects

**What:** a storage object with no `receipts` row and no reference in any submission snapshot. They are harmless (nothing can reach them through the API) and arise only when a best-effort cleanup fails:
- the database insert after an upload failed and deleting the just-written object failed too (`reason: 'upload_rolled_back'`);
- a receipt or line on a **never-submitted** claim was removed and the post-commit delete failed (`receipt_deleted`, `line_removed`);
- the process died between writing the object and inserting the row.

Each logged failure is a `receipt.object_orphaned` warn line with the `storageKey`. Objects that any snapshot references are **evidence and are never deleted** (D-31), even when their line or receipt row is gone.

**Find them.** Referenced keys, from the database:

```sql
SELECT r.storage_key AS key FROM public.receipts r
UNION
SELECT rc ->> 'storageKey'
  FROM public.claim_submissions cs,
       jsonb_path_query(cs.snapshot, '$.lines[*].receipts[*]') AS rc
 ORDER BY 1;
```

Keys in the bucket (host, with the project's own S3 SDK and `.env`):

```bash
node --input-type=module -e "
import nextEnv from '@next/env';
import { S3Client, paginateListObjectsV2 } from '@aws-sdk/client-s3';
nextEnv.loadEnvConfig(process.cwd());
const e = process.env;
const s3 = new S3Client({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } });
for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: e.S3_BUCKET, Prefix: 'receipts/' }))
  for (const o of page.Contents ?? []) console.log(o.Key, o.LastModified.toISOString());
" | grep '^receipts/'
```

An orphan is a bucket key that is **not** in the referenced list **and** is older than one hour (younger objects may belong to an upload in flight). Keys look like `receipts/<claimId>/<lineItemId>/<uuid>`, so the claim is easy to look up.

**Fix:** delete only those orphans (`DeleteObject` with the same client, or the object store's console), and keep the list you deleted. Never delete a key that the query above returns. No sweeper runs in core; schedule this as a weekly job once uploads are real traffic.

## Total drift: `pnpm verify:integrity`

`scripts/verify-integrity.ts` prints every row of `v_claim_total_drift` (claims whose stored total differs from the sum of their lines) and **exits 1 if there is any**. It reads with the app's own `DATABASE_URL` (the view is `security_invoker` and `expense_app` may SELECT it), so it needs no owner credentials.

- Locally: `pnpm verify:integrity` → `v_claim_total_drift: 0 rows`.
- Inside the compose network, with the tools image:
  ```bash
  docker compose run --rm --no-deps -e DATABASE_URL="postgresql://expense_app:${APW}@postgres:5432/expense_claims" \
    migrate tsx --conditions=react-server scripts/verify-integrity.ts
  ```

**Schedule it as a production job.** On Azure, a **Container Apps Job** with a schedule trigger runs the same tools image and command against the production database, as the app's role:

- Trigger: schedule, e.g. every 30 minutes (`*/30 * * * *`); replica timeout 5 minutes; **no retries** (a failure is the signal).
- Image: the release's `tools` image; command `tsx --conditions=react-server scripts/verify-integrity.ts`.
- Configuration: the app revision's environment (`APP_ENV=production`, its https `APP_BASE_URL`, storage settings), and `DATABASE_URL` for **`expense_app`** from Key Vault through the job's managed identity. Never the owner secret.
- Alert: an Azure Monitor alert on failed job executions (exit code 1), routed to the on-call channel. The job's stdout (Log Analytics) lists the drifting claims.
- Keep the readiness probe as the second line: a disabled integrity trigger already takes app replicas out of rotation (503).

A sketch with the Azure CLI (names are placeholders; check flags against your CLI version):

```bash
az containerapp job create -g <rg> -n expense-integrity --environment <aca-env> \
  --trigger-type Schedule --cron-expression "*/30 * * * *" \
  --replica-timeout 300 --replica-retry-limit 0 \
  --image <registry>/expense-claims-tools:<version> \
  --command tsx --args "--conditions=react-server" "scripts/verify-integrity.ts" \
  --mi-user-assigned <identity-id> \
  --secrets "database-url=keyvaultref:<app-db-url-secret-uri>,identityref:<identity-id>" \
  --env-vars DATABASE_URL=secretref:database-url APP_ENV=production APP_BASE_URL=https://<host> <storage settings…>
```

**If it ever reports a row:** treat it as a security incident, not a data fix. Drift requires a superuser to have disabled triggers and the deferred check (the app's role cannot). Keep the output, check the database audit log (pgaudit in production) and who held owner or superuser access, and repair under DBA control. Never "fix" it by giving the app more privileges.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in fails with **403 `CSRF_REJECTED`** | The page was opened on `http://127.0.0.1:3000` (or another host or port); the browser's `Origin` must equal `APP_BASE_URL` | Use **<http://localhost:3000>**. If you change `APP_PORT`, set `APP_BASE_URL=http://localhost:<APP_PORT>` too and recreate the app (`docker compose up -d app`) |
| `docker compose up` stops with `Run cp .env.example .env` | No `.env`: compose interpolation requires the passwords | `cp .env.example .env` |
| `bind: address already in use` on 3000, 5432 or 8333 | A local Postgres, another dev server or a second stack holds the port | Find it: `lsof -nP -iTCP:5432 -sTCP:LISTEN`. Stop it, or set `APP_PORT` / `POSTGRES_HOST_PORT` / `S3_HOST_PORT` in `.env`, and update the host URLs that use them (`DATABASE_URL`, `MIGRATE_DATABASE_URL`, `PERF_DATABASE_URL`, `S3_ENDPOINT`, `APP_BASE_URL`, `E2E_BASE_URL`) |
| Builds crawl, containers exit 137, Testcontainers times out | The Docker VM is short of memory | Give Docker at least 6 GB (Docker Desktop → Settings → Resources), then `docker compose up --build --wait` |
| `--wait` fails; `app` exited 1 | A boot check refused to start: invalid env, owner or superuser variables present, a privileged DB role, or a malformed policy | `docker compose logs app`: the first line names the problem (e.g. `Refusing to boot, forbidden variables set: …`) |
| `migrate` exited non-zero | Postgres or the object store not reachable, a failed migration, or a seed error | `docker compose logs migrate`; fix, then `docker compose up --wait` (re-runs the job) |
| Password authentication failed for `expense_app` / `expense_owner` | `.env` passwords changed after the volume was created | `docker compose down -v` and start again |
| `/api/health/ready` returns 503 with `integrityTriggers: fail` | Someone with owner rights disabled a trigger | `psql_app -c "SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'"`; re-enable it as the owner and find out who disabled it |
| Receipt upload or download returns 503 `SERVICE_UNAVAILABLE`; ready shows `storage: degraded` | The object store is down or the bucket is missing | `docker compose ps objectstore`; `docker compose run --rm migrate ensure-bucket` |
| A CSV download stops part-way | The stream errored (DB error, or the app stopped) and the download is failed on purpose rather than truncated | `docker compose logs app \| grep export.failed`; retry the export |
| Logged out unexpectedly | 60 minutes idle or 12 hours absolute | Sign in again |
| `pnpm start` on the host refuses to boot | `.env` holds owner credentials and `next start` runs in production mode | By design; production-mode runs go through compose. Use `pnpm dev` on the host |
| `pnpm test:int` can't start a container | Docker isn't running | Start Docker, or point `TEST_PG_SUPERUSER_URL` at an empty PostgreSQL 18 |
| The demo data looks different from the demo script (extra "E2E …" claims) | `pnpm test:e2e` creates uniquely titled claims and never resets the database | `docker compose down -v && docker compose up --build --wait` before a demo |
