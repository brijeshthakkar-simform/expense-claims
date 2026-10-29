// Writes plan-inputs/verified.sql = 01-roles.sh SQL + the exact migration.sql files that passed the proof.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = new URL('.', import.meta.url).pathname;
const DEST = process.argv[2];
const ms = JSON.parse(readFileSync(join(ROOT, 'out/migrations.json'), 'utf8'));
const results = JSON.parse(readFileSync(join(ROOT, 'out/results.json'), 'utf8'));
const passed = results.filter((r) => r.passed).length;
const pgv = (readFileSync(join(ROOT, 'out/run.log'), 'utf8').match(/PostgreSQL [0-9.]+/) ?? ['PostgreSQL ?'])[0];
const roles = readFileSync(join(ROOT, 'sql/00_roles.sql'), 'utf8')
  .replace(/^-- =+\n-- docker\/postgres[\s\S]*?-- =+\n\n/, '')
  .replaceAll("'{{OWNER_PW}}'", "'${DB_OWNER_PASSWORD}'").replaceAll("'{{APP_PW}}'", "'${DB_APP_PASSWORD}'")
  .replace('-- @@DB\n', '').replace(/-- @@IN_DB.*\n/, '\\connect expense_claims\n')
  .replaceAll('{{DB}}', 'expense_claims');
const bar = '-- ' + '='.repeat(100);
let out = `${bar}
-- verified.sql — Expense Claims POC: the data-integrity SQL, PROVEN against a real PostgreSQL
--
-- Verified 2026-10-13 on ${pgv} (npm embedded-postgres 18.4.0-beta.17; canonical pins the 18.6 image)
-- with Prisma CLI 7.10.0: \`prisma migrate deploy\` as expense_owner applied every migration below, and
-- \`prisma migrate diff\` (live DB -> schema.prisma) and (migrations replayed in a shadow DB -> schema.prisma)
-- are both EMPTY. ${passed}/${results.length} tests green, attacks run as the least-privilege role expense_app
-- (multi-connection concurrency included). Test catalogue, bugs fixed and harness: sqlproof-report.md.
--
-- Layout = the planned Prisma migrations (canonical C-23), in apply order. Each migration.sql is EXACTLY
-- the concatenation of its blocks:
--   >>>> PRISMA-GENERATED  -> run \`pnpm prisma migrate dev --create-only --name <name>\`, do not hand-write
--   >>>> HAND-WRITTEN      -> paste where the label says (prepend / append) BEFORE applying the migration
-- The superuser bootstrap (docker/postgres/initdb/01-roles.sh) is not a migration; it runs first.
--
-- Function versions (CREATE OR REPLACE keeps the triggers bound):
--   #1 assert_claim_editable   v1 in 0002 -> v2 in 0004 (adds the snapshot freeze)
--   #4 claims_guard            v1 in 0002 -> v2 in 0004 (full whitelist + chain / approval / audit preconditions)
--   #6 claim_submissions_verify v1 in 0004 -> v2 in 0005 (adds receipt verification)
-- SQLSTATEs: UC001 CLAIM_LOCKED · UC002 CLAIM_NOT_EDITABLE · UC003 TOTAL_IS_DERIVED · UC004 NO_LINE_ITEMS ·
--   UC005 INVALID_STATUS_TRANSITION · UC006 ALREADY_DECIDED · UC007 APPEND_ONLY · UC008 APPROVER_NOT_ELIGIBLE ·
--   UC009 TOTAL_MISMATCH · UC010 IMMUTABLE_FIELD · UC011 APPROVAL_INCOMPLETE · UC012 CHAIN_INVALID ·
--   UC013 CATEGORY_INACTIVE · UC014 EXPENSE_DATE_IN_FUTURE · UC015 AUDIT_EVENT_MISSING · UC016 SNAPSHOT_MISMATCH ·
--   UC017 CLAIM_HAS_HISTORY  (canonical C-05; the app maps by SQLSTATE only)
${bar}


${bar}
-- not a migration: docker/postgres/initdb/01-roles.sh  (postgres superuser, first boot, empty volume)
-- Wrap in: psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL ... SQL
-- (psql autocommits each statement, which CREATE DATABASE requires; from a driver send them one by one.)
-- Re-run the database part for every database that needs prod privileges (expense_perf, the Testcontainers DB).
${bar}
${roles.trimEnd()}
`;
for (const m of ms) {
  out += `\n\n${bar}\n-- migration: ${m.id}  ->  prisma/migrations/${m.dir}/migration.sql   (phase ${m.phase})\n${bar}\n`;
  out += readFileSync(join(ROOT, 'out/migrations-full', m.dir, 'migration.sql'), 'utf8').trimEnd() + '\n';
}
out += `\n\n${bar}
-- NOT VERIFIED HERE (OPTIONAL in canonical C-23): …_export_runs (BUF), …_receipt_upload_intents (§8 BUF).
-- If built, follow the same pattern: explicit grants in the migration, schema-qualified functions with a pinned
-- search_path, and a guard trigger allowing exactly one RUNNING -> SUCCEEDED/FAILED transition on export_runs.
${bar}
`;
writeFileSync(DEST, out);
console.log(`wrote ${DEST} (${out.length} chars, ${out.split('\n').length} lines)`);
