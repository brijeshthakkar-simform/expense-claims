# ADR-0008: Two database roles, and migrations as a one-shot job

- **Status:** Accepted (Phase 0, 2026-10-14; the release order changed in Phase 8, see below)
- **Decision ids:** D-34, D-35, D-38, D-39, D-45 in [00-decisions-and-contracts](../design/00-decisions-and-contracts.md)
- **Detail:** [03 §8](../design/03-data-model-and-integrity.md#8-database-roles-grants-and-credential-separation), [01 §11](../design/01-architecture-and-stack.md)

## Context

"Provably impossible to desynchronise" (§6) and "approved = read-only" (§3.4) only hold if the credentials the app runs with cannot switch the database's guards off. If the app connected as the owner or a superuser, one compromised request could `DISABLE TRIGGER`, `TRUNCATE` or rewrite history. §6 also requires `docker compose up` with nothing but a documented `.env`, which means migrations and seed must run by themselves, in order.

## Decision

**Roles** (`docker/postgres/initdb/01-roles.sh` creates them on first boot; table grants live in the migrations):

| Role | Used by | Can |
|---|---|---|
| `postgres` | the image's initdb only | everything; never used again |
| `expense_owner` | the `migrate` job and host CLI (`db:*`, `policy:activate-tier`, `perf:*`) | owns every object; DDL; writes reference and policy tables |
| `expense_app` | the app container | row-level DML per table only; owns nothing; `NOINHERIT` |

`expense_app` gets explicit grants per table (no `ALTER DEFAULT PRIVILEGES`, so a new table is never accidentally writable): SELECT only on `users`, `departments`, `categories` and `approval_policy_tiers`; SELECT+INSERT on `claim_submissions` and `claim_events`; no UPDATE on `receipts`; no DELETE on `approval_steps`. No TRUNCATE, TRIGGER, REFERENCES, TEMP or CREATE anywhere. Triggers stamp transition timestamps for `expense_app` (it cannot backdate), while the owner may supply them at legal transitions, which is how the seed dates its history.

**Migrations as a job.** The Dockerfile builds two targets from one image: `runner` (Next standalone `server.js`, uid 1000, no CLI, no `.env`) and `tools` (`docker/tools/entrypoint.sh`: `migrate | seed | ensure-bucket | release`). Compose runs `migrate` with `release` = `prisma migrate deploy` → ensure the receipts bucket → seed. The seed always upserts reference data; the demo cast and claims C01–C12 run only when `SEED_ON_START=true` and `users` is empty, through the real services with every trigger on. (Phase 8 moved ensure-bucket before the seed, because the seed now uploads C04's receipt through the receipts service.) The app `depends_on` `migrate: service_completed_successfully`.

**Credential separation and self-checks.** No service uses `env_file`; each lists its variables, so the app never receives the owner URL, role passwords or the seed password. At boot (`src/instrumentation.ts`) the app exits 1 if its config is invalid, if any forbidden variable is present in production mode, if its database role is privileged (`assertRuntimeRole`: not `expense_app`, superuser, BYPASSRLS, CREATEROLE, CREATEDB, owns relations, member of the owner), or if the policy is malformed. `/api/health/ready` returns 503 while any integrity trigger is disabled. Migrations are hand-written SQL appended to Prisma's output; `db push` is banned and CI checks drift (`pnpm db:deploy && pnpm db:diff-check`).

## Consequences

- Raw SQL from a compromised app hits the same triggers and gets 42501 for anything that would switch them off.
- Releasing is a step before the new app version starts, which maps 1:1 to an Azure Container Apps Job; only that job's identity reads the owner secret (Key Vault).
- `pnpm start` on the host refuses to boot while `.env` holds owner credentials; production-mode runs go through compose.
- Cost: reference data and the org chart change only through migrations or owner scripts (ADMIN has no UI), and every new table needs its grant line in its migration.

## Evidence

- TC-I07 (`tests/integration/db/privileges.int.test.ts`) › "privilege matrix for expense_app matches the expected matrix for every table in public", "expense_app cannot DISABLE TRIGGER, TRUNCATE, or SET session_replication_role (42501)", "expense_app cannot UPDATE or DELETE claim_events or claim_submissions", "expense_app cannot write users, departments, categories or approval_policy_tiers", "expense_app has no TEMP or CREATE privilege".
- TC-I06 › "assertRuntimeRole rejects the owner role and accepts expense_app", "/api/health/ready returns 503 NOT_READY when an integrity trigger is disabled"; TC-I08 › "each table has exactly the expected triggers, all enabled", "every plpgsql function pins search_path = pg_catalog, public, pg_temp".
- TC-U11 › "the forbidden owner and superuser variables are detected in production mode", "staging and production reject SEED_ON_START=true, DEMO_MODE=true or a SEED_DEMO_PASSWORD".
- TC-E06 › "a clean docker compose up is healthy and the app container holds no owner or superuser credentials"; TC-I28 › "backdating approved_at as expense_app raises UC010".
- Live: `docker compose exec app env` shows only the `expense_app` URL; `scripts/demo/sql-attacks.sh` gets 42501 twice.
