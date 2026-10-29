// `prisma db seed` (pnpm db:seed, and `release` in the tools image). Runs as expense_owner in two
// parts (D-45, 03 §12.1):
//   1. seedReference(): every run, every environment (idempotent ON CONFLICT DO NOTHING inserts):
//      departments, categories and the approval tiers (L4_CFO inactive, once deepa exists).
//   2. the C-15 cast and the demo claims: only when SEED_ON_START=true AND users is empty; refused
//      in staging/production and for any non-.test email. The demo claims go through the real
//      services with a SeedClock (prisma/seed-claims.ts); P3 seeds C01 and C02, P4–P5 the rest.
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
if (!ownerUrl) {
  console.error('[seed] MIGRATE_DATABASE_URL is not set (the seed runs as expense_owner)');
  process.exit(1);
}
// The owner URL exists only inside this process, so the services imported below connect as the
// owner and the DB keeps the SeedClock timestamps (D-23). Modules are imported only after this.
process.env.DATABASE_URL = ownerUrl;

const log = (msg: string) => console.log(`[seed] ${msg}`);

let exitCode = 0;
try {
  const { seedCast, seedReference, withOwnerTx } = await import('./seed-personas');
  const appEnv = process.env.APP_ENV ?? 'local';
  const seedOnStart = process.env.SEED_ON_START === 'true';

  const castSeeded = await withOwnerTx(ownerUrl, async (sql): Promise<boolean> => {
    await seedReference(sql);
    log('reference data ensured (departments, categories, approval tiers)');

    if (!seedOnStart) {
      log('demo cast skipped: SEED_ON_START is not true');
      return false;
    }
    if (appEnv === 'staging' || appEnv === 'production')
      throw new Error(`SEED_ON_START=true is refused with APP_ENV=${appEnv}`);
    // Serialises concurrent seeds, so "users is empty" can't be true for two of them at once.
    await sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`;
    const [row] = await sql`SELECT EXISTS (SELECT 1 FROM users) AS has_users`;
    if (row?.has_users) {
      log('demo cast and claims skipped: users is not empty');
      return false;
    }

    const password = process.env.SEED_DEMO_PASSWORD;
    if (!password) throw new Error('SEED_ON_START=true needs SEED_DEMO_PASSWORD');
    const inserted = await seedCast(sql, { password, appEnv });
    await seedReference(sql); // again: L4_CFO (inactive) needs its designated user, deepa
    log(`demo cast seeded: ${inserted} @acme.test users; L4_CFO tier ensured (inactive)`);
    return inserted > 0;
  });

  // After COMMIT: the services use their own connection pool, which must see the committed cast.
  if (castSeeded) {
    const { seedDemoClaims } = await import('./seed-claims');
    try {
      const ids = await seedDemoClaims();
      log(`demo claims seeded: ${Object.keys(ids).join(', ')}`);
    } catch (err) {
      // The cast is committed, so a re-run skips this part: start again from an empty volume.
      log('demo claims failed after the cast was committed; reset with `docker compose down -v`');
      throw err;
    }
  }
} catch (err) {
  console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  const { disconnectDb } = await import('@/server/db/client');
  await disconnectDb().catch(() => {});
}
process.exit(exitCode);
