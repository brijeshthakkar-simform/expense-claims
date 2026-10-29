import 'server-only';
import { readinessProbe, withTimeout } from '@/server/db/introspection';
import { logger } from '@/server/logging/logger';
import { getStorage } from '@/server/storage/receipt-storage';

const READINESS_TIMEOUT_MS = 1_000;

export interface ReadinessChecks {
  db: 'ok' | 'fail';
  integrityTriggers: 'ok' | 'fail' | 'unknown';
  /** Reported only: a store outage fails the receipt routes (503), never readiness (D-41). */
  storage: 'ok' | 'degraded';
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessChecks;
}

/** The process answers; no dependencies, so a DB blip never restarts the app (D-41). */
export function liveness(): { status: 'live' } {
  return { status: 'live' };
}

/**
 * Ready = the DB answers within 1 s AND no integrity trigger in public is disabled. With a
 * trigger off, "provably impossible" stops being true, so the instance leaves rotation (RT-B3).
 * Storage is pinged in parallel and only reported: pulling the instance for a store blip would
 * turn a receipts-only outage into a full one (06 §3.2).
 */
export async function readiness(): Promise<ReadinessReport> {
  const [probe, storageOk] = await Promise.all([
    readinessProbe(READINESS_TIMEOUT_MS).catch((err: unknown) => {
      logger.warn({ err }, 'readiness probe failed');
      return null;
    }),
    pingStorage(),
  ]);
  const checks: ReadinessChecks = {
    db: probe ? 'ok' : 'fail',
    integrityTriggers: !probe ? 'unknown' : probe.disabledTriggers === 0 ? 'ok' : 'fail',
    storage: storageOk ? 'ok' : 'degraded',
  };
  const ready = checks.db === 'ok' && checks.integrityTriggers === 'ok';
  if (!ready) logger.warn({ checks, disabledTriggers: probe?.disabledTriggers }, 'not ready');
  else if (!storageOk) logger.warn({ checks }, 'receipt storage degraded');
  return { ready, checks };
}

/** ReceiptStorage.ping() within 1 s; any failure (including bad storage config) is false. */
async function pingStorage(): Promise<boolean> {
  try {
    return await withTimeout(getStorage().ping(), READINESS_TIMEOUT_MS, 'storage ping');
  } catch {
    return false;
  }
}
