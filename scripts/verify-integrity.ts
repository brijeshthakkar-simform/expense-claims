// pnpm verify:integrity (tsx --conditions=react-server): the live §6-5 check. Prints every row of
// v_claim_total_drift (claims whose stored total differs from the sum of their lines) and exits 1
// if there is any. Reads with the app's DATABASE_URL (C-18): the view is security_invoker and
// expense_app may SELECT it, so no owner credentials are needed.
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const log = (msg: string) => console.log(`[verify:integrity] ${msg}`);

const { readTotalDrift } = await import('../src/server/repositories/integrity.repo');
const { disconnectDb } = await import('../src/server/db/client');

let exitCode = 0;
try {
  const rows = await readTotalDrift();
  if (rows.length > 0) console.table(rows);
  log(`v_claim_total_drift: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  if (rows.length > 0) {
    log('FAIL: claims.total_minor differs from SUM(line_items.amount_minor) for the claims above');
    exitCode = 1;
  } else {
    log('OK: every claim total equals the sum of its line items');
  }
} catch (err) {
  console.error(`[verify:integrity] failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await disconnectDb().catch(() => {});
}
process.exit(exitCode);
