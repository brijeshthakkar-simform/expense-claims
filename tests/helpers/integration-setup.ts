// Per-file setup for the integration project (07 §3.2): the environment app code under test sees,
// plus the hooks around every test.
import { afterAll, afterEach, beforeEach, inject } from 'vitest';

// getDb() and env() are lazy, so setting the environment before importing ./db is enough:
// app code under test connects as expense_app and nothing else.
process.env.DATABASE_URL = inject('appUrl');
Object.assign(process.env, {
  APP_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
  RECEIPT_STORAGE_DRIVER: 'memory',
  EXPORT_BATCH_SIZE: '3', // every route-level export test crosses keyset batch boundaries
  DEMO_MODE: 'false',
});
// App code can't reach owner or superuser credentials, even by accident.
for (const v of [
  'MIGRATE_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'POSTGRES_PASSWORD',
  'DB_OWNER_PASSWORD',
  'DB_APP_PASSWORD',
  'SEED_DEMO_PASSWORD',
  'TEST_PG_SUPERUSER_URL',
])
  delete process.env[v];

const { assertGuardsEnabled, assertTotalsInSync, closePools, closeTestClients, resetDb } =
  await import('./db');

beforeEach(resetDb);
afterEach(assertTotalsInSync); // every integration test is also a desync probe
afterEach(assertGuardsEnabled); // a sabotage test can't leave a trigger disabled for the next one
afterEach(closeTestClients); // after-hooks run in reverse, so this is first: no open tx blocks TRUNCATE
afterAll(closePools); // end the pg pools and the Prisma pool, so the worker exits cleanly
