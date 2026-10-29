// Database helpers for integration tests (07 §3.3). Three kinds of connection:
//   appSql / appClient     expense_app — what the production process can do (attacks, raw SQL)
//   ownerSql / ownerClient expense_owner — reset, sabotage, backdated fixtures; never app code
//   monitorSql             superuser — pg_stat_activity only (other roles' wait events)
import pg from 'pg';
import { expect, inject } from 'vitest';
import { disconnectDb, getDb } from '@/server/db/client';
import { readSqlState } from '@/server/db/pg-error';
import { restoreReference } from '../../prisma/seed-personas';

export type Row = pg.QueryResultRow;
export type Sql = <T extends Row = Row>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T[]>;

/** Tagged template → parameterised query ($1..$n); values are never interpolated. */
const toSql =
  (q: pg.Pool | pg.Client): Sql =>
  async <T extends Row = Row>(s: TemplateStringsArray, ...v: unknown[]) => {
    const text = s.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await q.query<T>(text, v)).rows;
  };

const pool = (connectionString: string, max: number, application_name: string) => {
  const p = new pg.Pool({ connectionString, max, application_name });
  p.on('error', () => {}); // an idle client killed by the server must not crash the worker
  return p;
};

const pools = {
  app: pool(inject('appUrl'), 4, 'test-app'),
  owner: pool(inject('ownerUrl'), 2, 'test-owner'),
  monitor: pool(inject('superUrl'), 1, 'test-monitor'),
};
export const appSql = toSql(pools.app);
export const ownerSql = toSql(pools.owner);
export const monitorSql = toSql(pools.monitor);

export type TestClient = pg.Client & { sql: Sql };
const opened: pg.Client[] = [];
async function client(connectionString: string, application_name: string): Promise<TestClient> {
  const c = new pg.Client({ connectionString, application_name });
  c.on('error', () => {}); // surfaces on the next query instead
  await c.connect();
  opened.push(c);
  return Object.assign(c, { sql: toSql(c) });
}
/** A dedicated connection (explicit BEGIN/COMMIT, concurrency). Closed after every test. */
export const appClient = () => client(inject('appUrl'), 'test-app-client');
export const ownerClient = () => client(inject('ownerUrl'), 'test-owner-client');

export async function closeTestClients() {
  await Promise.all(opened.splice(0).map((c) => c.end().catch(() => {})));
}
/** Ends the pg pools and the app's Prisma pool, so the worker exits cleanly. */
export async function closePools() {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await disconnectDb();
}

/** BEGIN … COMMIT on one connection. Deferred errors (UC009, UC015) surface at COMMIT, so it's inside. */
export async function tx<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    const r = await fn();
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

export async function errorOf(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => null,
    (e: unknown) => e,
  );
}

/** Asserts the exact SQLSTATE: pg errors, Prisma P2039/P2010 and commit-time DriverAdapterErrors. */
export async function rejects(code: string, fn: () => Promise<unknown>): Promise<unknown> {
  const err = await errorOf(fn);
  expect(err, `expected SQLSTATE ${code}, but the statement succeeded`).not.toBeNull();
  expect(readSqlState(err), String((err as Error | null)?.message)).toBe(code);
  return err;
}

// Tables the owner truncates before every test (07 §3.1); later migrations add the rest of the
// list, and only the ones that exist are truncated. The sequence is not restarted.
const RESET_TABLES = [
  'claims',
  'line_items',
  'receipts',
  'claim_submissions',
  'approval_steps',
  'claim_events',
  'sessions',
  'export_runs',
];
let resetStatement: string | undefined;

export async function resetDb() {
  if (!resetStatement) {
    const present = await ownerSql<{ t: string }>`
      SELECT t FROM unnest(${RESET_TABLES}::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL`;
    resetStatement = `TRUNCATE ${present.map(({ t }) => pg.escapeIdentifier(t)).join(', ')}`;
  }
  sink = null; // a capture never outlives its test
  await pools.owner.query(resetStatement); // one statement: handles the FK cycle, fires no row triggers
  // Idempotent, and first: a cast member re-pointed at a tmp.* manager would block the DELETE
  // (users_manager_id_fkey is RESTRICT). P1: categories' is_active and the cast's flags.
  await restoreReference(ownerSql);
  await ownerSql`DELETE FROM users WHERE email LIKE 'tmp.%'`;
  // P6: no stored object, fault or hook outlives its test (MemoryReceiptStorage; other drivers
  // have no clear()). Imported lazily: getStorage() reads env() on first use, and a test may have
  // swapped the adapter with setStorageForTests(), which is undone here too.
  const storage = await import('@/server/storage/receipt-storage');
  storage.setStorageForTests(undefined);
  (storage.getStorage() as { clear?(): void }).clear?.();
}

/** Every integration test is also a desync probe (07 §6). */
export async function assertTotalsInSync() {
  expect(
    await ownerSql`SELECT claim_id, total_minor, line_sum FROM v_claim_total_drift`,
    'claims.total_minor differs from the sum of line_items.amount_minor',
  ).toEqual([]);
}

/** A sabotage test must not leave a trigger off for the next test: re-enable it, then fail. */
export async function assertGuardsEnabled() {
  const off = await ownerSql<{ relname: string; tgname: string }>`
    SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled IN ('D', 'R')`;
  for (const { relname, tgname } of off)
    await pools.owner.query(
      `ALTER TABLE public.${pg.escapeIdentifier(relname)} ENABLE TRIGGER ${pg.escapeIdentifier(tgname)}`,
    );
  expect(off, 'integrity triggers were left disabled').toEqual([]);
}

// Concurrency: prove a lock wait instead of sleeping (07 §3.4 rule 2).
export async function pidOf(c: pg.Client): Promise<number> {
  return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}
/** Polls pg_stat_activity until `pid` waits on a lock; returns e.g. `Lock/transactionid`. */
export async function waitUntilBlocked(pid: number, timeoutMs = 5_000): Promise<string> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const [row] = await monitorSql<{ wait_event_type: string | null; wait_event: string | null }>`
      SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait_event_type === 'Lock') return `${row.wait_event_type}/${row.wait_event}`;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}
/**
 * Polls until at least `count` expense_app backends wait on a lock. For requests that go through
 * the app's Prisma pool, whose backend pids a test can't know (TC-I20): each contender is sent
 * only once the previous one is queued, so they queue behind gate() in a known order.
 */
export async function waitForLockWaiters(count: number, timeoutMs = 5_000): Promise<void> {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const [row] = await monitorSql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE usename = 'expense_app' AND wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`fewer than ${count} expense_app backends ever waited on a lock`);
}
/** Holds the claim row lock from a third connection, so contenders queue in a known order. */
export async function gate(claimId: string) {
  const c = await ownerClient();
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM claims WHERE id = $1 FOR NO KEY UPDATE', [claimId]);
  return { release: () => c.query('COMMIT') };
}

// SQL capture (TC-I17). getDb() emits Prisma `query` events only when APP_ENV=test (client.ts);
// they are never logged. One listener per client; `captureQueries()` starts a fresh list.
let sink: string[] | null = null;
let hooked: ReturnType<typeof getDb> | undefined;
/** Records the SQL text of every statement Prisma sends from now on (until the next call/test). */
export function captureQueries(): string[] {
  const db = getDb();
  if (hooked !== db) {
    db.$on('query', (e) => sink?.push(e.query));
    hooked = db;
  }
  return (sink = []);
}
