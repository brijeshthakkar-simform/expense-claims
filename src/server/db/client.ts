import 'server-only';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/server/env';
import { logger } from '@/server/logging/logger';

type LogDef = { emit: 'event'; level: 'query' | 'warn' };

/** The app's client type. `query` events exist only when APP_ENV=test (TC-I17 captures SQL). */
export type Db = PrismaClient<'query' | 'warn'>;

const g = globalThis as unknown as { __db?: Db };

/** Lazy (so `next build` needs no env), one pool per process, survives dev HMR. */
export function getDb(): Db {
  if (g.__db) return g.__db;
  const e = env();
  const adapter = new PrismaPg({
    connectionString: e.DATABASE_URL,
    max: e.DB_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'expense-claims-app',
  });
  // Query events are emitted, never logged: they carry bound parameters. Errors are not
  // forwarded here because every thrown error is mapped and logged once, with its requestId.
  const log: LogDef[] = [{ emit: 'event', level: 'warn' }];
  if (e.APP_ENV === 'test') log.push({ emit: 'event', level: 'query' });
  const db: Db = new PrismaClient({ adapter, log });
  db.$on('warn', (ev) => logger.warn({ prismaTarget: ev.target }, ev.message));
  return (g.__db = db);
}
// statement_timeout 15s, lock_timeout 5s and idle_in_transaction_session_timeout 30s are ROLE
// settings on expense_app (01-roles.sh), so no client configuration can loosen them by accident.

/** Closes the pool (test teardown, scripts). The next getDb() call opens a fresh one. */
export async function disconnectDb(): Promise<void> {
  const db = g.__db;
  g.__db = undefined;
  await db?.$disconnect();
}
