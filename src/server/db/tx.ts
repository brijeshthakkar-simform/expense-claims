import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { getDb } from '@/server/db/client';
import { isPrismaCode, readSqlState, SQLSTATE } from '@/server/db/pg-error';
import { AppError } from '@/server/errors/app-error';

export type Tx = Prisma.TransactionClient;

const MAX_RETRIES = 2;
const RETRYABLE = new Set<string>([SQLSTATE.SERIALIZATION_FAILURE, SQLSTATE.DEADLOCK_DETECTED]);

/** 40001 / 40P01, or Prisma's P2034 wrapper for the same: safe to re-run the whole callback. */
export const isRetryableTxError = (err: unknown): boolean =>
  RETRYABLE.has(readSqlState(err) ?? '') || isPrismaCode(err, 'P2034');

// Small randomised backoff so two losers of the same deadlock don't collide again in lockstep.
const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 40));

/**
 * The only way services open a transaction (D-14, 02 §8): READ COMMITTED, maxWait 5 s, timeout
 * 10 s. Serialization failures and deadlocks re-run `fn` on a fresh transaction up to twice, then
 * become 409 CONFLICT; a lock_timeout (55P03) is CONFLICT at once. The catch wraps $transaction
 * itself, so errors raised by deferred triggers at COMMIT (UC009, UC015) are seen here too.
 * `fn` must do no network I/O: it may run more than once.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getDb().$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (err) {
      if (err instanceof AppError) throw err; // business refusals pass through untouched
      if (isRetryableTxError(err)) {
        if (attempt < MAX_RETRIES) {
          await backoff(attempt);
          continue;
        }
        throw new AppError('CONFLICT', undefined, { retryable: true }, { cause: err });
      }
      if (readSqlState(err) === SQLSTATE.LOCK_NOT_AVAILABLE)
        throw new AppError('CONFLICT', undefined, { retryable: true }, { cause: err });
      throw err; // mapped by SQLSTATE in map-error.ts (C-05)
    }
  }
}
