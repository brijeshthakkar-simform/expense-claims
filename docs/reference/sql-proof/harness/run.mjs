// Orchestrates the proof: embedded PG 18 → roles (01-roles.sh) → `prisma migrate deploy` as expense_owner
// → P0 spike suite on the P0 migration subset → full suite on all migrations → Prisma drift checks → stop.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCluster, stopCluster, applyRoles, prisma, ownerUrl, appUrl, connect, suUrl, results, group, test, eq, ROOT } from './lib/harness.mjs';
import { runP0 } from './lib/tests_p0.mjs';

const only = process.argv[2] ?? 'all';
const env = (db, migrations) => ({ MIGRATE_DATABASE_URL: ownerUrl(db), PRISMA_MIGRATIONS: migrations, PRISMA_SCHEMA: 'out/schema.prisma' });

await startCluster();
try {
  const su = await connect(suUrl());
  const { rows: [v] } = await su.query('SELECT version() AS v');
  console.log(v.v);
  await su.end();

  if (only === 'all' || only === 'p0') {
    await applyRoles('expense_claims_p0');
    const d = prisma(['migrate', 'deploy'], env('expense_claims_p0', 'out/migrations-p0'));
    console.log(d.out.split('\n').filter((l) => /migration|applied|Error|error/i.test(l)).join('\n'));
    if (d.code !== 0) throw new Error(`migrate deploy (P0) failed:\n${d.out}`);
    await runP0('expense_claims_p0');
  }

  if (only === 'all' || only === 'full') {
    await applyRoles('expense_claims');
    const d = prisma(['migrate', 'deploy'], env('expense_claims', 'out/migrations-full'));
    console.log(d.out.split('\n').filter((l) => /migration|applied|Error|error/i.test(l)).join('\n'));
    if (d.code !== 0) throw new Error(`migrate deploy (full) failed:\n${d.out}`);

    group('Prisma schema ↔ migrations consistency');
    await test('PR-1', 'prisma migrate diff: live DB (after deploy) → schema.prisma is empty', async () => {
      const r = prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'out/schema.prisma', '--exit-code'], env('expense_claims', 'out/migrations-full'));
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out}`);
      return 'exit 0 (no difference)';
    });
    await test('PR-2', 'prisma migrate diff: migrations folder (replayed in a shadow DB) → schema.prisma is empty', async () => {
      const su2 = await connect(suUrl());
      await su2.query('CREATE DATABASE expense_claims_shadow OWNER expense_owner');   // Prisma resets but does not create it
      await su2.end();
      const r = prisma(['migrate', 'diff', '--from-migrations', 'out/migrations-full', '--to-schema', 'out/schema.prisma', '--exit-code'],
        { ...env('expense_claims', 'out/migrations-full'), SHADOW_DATABASE_URL: ownerUrl('expense_claims_shadow') });
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out}`);
      return 'exit 0 (no difference; shadow replay of all 5 migrations incl. hand SQL succeeded)';
    });

    await test('PR-3', 'P0 exit criterion: `prisma migrate dev --create-only` (owner; Prisma auto-creates its shadow DB via CREATEDB) finds no drift and generates an EMPTY migration, twice', async () => {
      const { cpSync, rmSync, readdirSync, readFileSync } = await import('node:fs');
      const outs = [];
      for (let i = 0; i < 2; i++) {
        const dir = join(ROOT, `out/migrations-devcheck-${i}`);
        rmSync(dir, { recursive: true, force: true });
        cpSync(join(ROOT, 'out/migrations-full'), dir, { recursive: true });
        const r = prisma(['migrate', 'dev', '--name', 'should_be_empty', '--create-only'], env('expense_claims', `out/migrations-devcheck-${i}`));
        if (r.code !== 0) throw new Error(`run ${i + 1} exit ${r.code}: ${r.out}`);
        const created = readdirSync(dir).find((d) => d.endsWith('_should_be_empty'));
        const body = readFileSync(join(dir, created, 'migration.sql'), 'utf8').trim();
        if (body !== '-- This is an empty migration.') throw new Error(`run ${i + 1} generated SQL: ${body.slice(0, 500)}`);
        outs.push(`run ${i + 1}: "${body}"`);
        rmSync(dir, { recursive: true, force: true });
      }
      return outs.join(' | ');
    });

    const { runFull } = await import('./lib/tests_full.mjs');
    await runFull('expense_claims');

    group('Prisma 7.10 client + @prisma/adapter-pg: error shapes of the DB backstops (for readSqlState)');
    const { execFileSync } = await import('node:child_process');
    let shapes = [];
    try {
      const outTxt = execFileSync(join(ROOT, 'node_modules/.bin/tsx'), ['probe-client/probe.ts'], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: appUrl('expense_claims') }, stdio: ['ignore', 'pipe', 'pipe'] });
      shapes = JSON.parse(outTxt.slice(outTxt.indexOf('[')));
    } catch (e) { shapes = [{ label: 'probe crashed', ok: false, note: String(e.stderr ?? e).slice(0, 1500) }]; }
    writeFileSync(join(ROOT, 'out/prisma-error-shapes.json'), JSON.stringify(shapes, null, 2));
    for (const sh of shapes.filter((x) => 'expected' in x || x.label === 'probe crashed')) {
      await test('PE', `${sh.label} → readSqlState() = ${sh.expected}`, async () => {
        if (!sh.ok) throw new Error(JSON.stringify(sh));
        return `${sh.ctor}/${sh.code ?? '-'}; meta.driverAdapterError.cause=${JSON.stringify(sh.driverAdapterError_cause ?? null)}; cause=${JSON.stringify(sh.cause ?? null)}`;
      });
    }
    for (const sh of shapes.filter((x) => !('expected' in x))) console.log('  info', JSON.stringify(sh));
  }

  if (only === 'all' || only === 'bugs') {
    await applyRoles('expense_claims_bugdemo');
    const d = prisma(['migrate', 'deploy'], env('expense_claims_bugdemo', 'out/migrations-full'));
    if (d.code !== 0) throw new Error(`migrate deploy (bugdemo) failed:\n${d.out}`);
    const { runBugEvidence } = await import('./lib/tests_bugs.mjs');
    await runBugEvidence('expense_claims_bugdemo');
  }
} catch (e) {
  console.error('HARNESS ERROR', e);
  results.push({ group: 'harness', id: 'HARNESS', name: 'harness error', passed: false, notes: String(e?.message ?? e).slice(0, 2000) });
} finally {
  await stopCluster();
}

const failed = results.filter((r) => !r.passed);
writeFileSync(join(ROOT, 'out/results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`FAILED ${f.id} ${f.name}: ${f.notes}`);
process.exit(failed.length ? 1 : 0);
