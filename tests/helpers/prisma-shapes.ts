// The Prisma 7.10 + @prisma/adapter-pg error shapes recorded by the SQL proof on a real PostgreSQL
// (docs/reference/sql-proof/harness/out/prisma-error-shapes.json). TC-U08 rebuilds each one;
// TC-I04/TC-I05 throw the commit-time DriverAdapterError from a test-only route.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AdapterErrorCause {
  code?: string;
  kind: string;
  originalCode: string;
  originalMessage: string;
  constraint?: unknown;
}

/**
 * The raw `DriverAdapterError` thrown when a deferred trigger fails at COMMIT, and the value of
 * `meta.driverAdapterError` on P2039/P2010/P2002. No package we depend on exports the class, so
 * this mirrors its recorded shape: name 'DriverAdapterError', the postgres payload as `cause`.
 */
export class DriverAdapterError extends Error {
  override readonly name = 'DriverAdapterError';
  constructor(cause: AdapterErrorCause) {
    super(cause.originalMessage, { cause });
  }
}

export interface RecordedShape {
  label: string;
  expected: string;
  ctor: 'PrismaClientKnownRequestError' | 'DriverAdapterError';
  code?: string;
  metaModelName?: string;
  driverAdapterError_cause?: AdapterErrorCause;
  cause?: AdapterErrorCause;
  message: string;
  readSqlState: string;
}

const SHAPES_FILE = fileURLToPath(
  new URL('../../docs/reference/sql-proof/harness/out/prisma-error-shapes.json', import.meta.url),
);

/** The recorded error entries (the file also holds two non-error probes, skipped here). */
export function recordedErrorShapes(): RecordedShape[] {
  const all = JSON.parse(readFileSync(SHAPES_FILE, 'utf8')) as Partial<RecordedShape>[];
  return all.filter((s): s is RecordedShape => typeof s.expected === 'string');
}

/** UC012 at COMMIT, as Prisma surfaces it (no real route can provoke a backstop in P1). */
export const uc012 = () =>
  new DriverAdapterError({
    code: 'UC012',
    kind: 'postgres',
    originalCode: 'UC012',
    originalMessage: 'CHAIN_INVALID: claim EXP-2026-000107 has 1 step but its total needs 2 tiers',
  });
