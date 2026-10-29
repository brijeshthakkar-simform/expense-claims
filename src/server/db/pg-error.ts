import 'server-only';

/** C-05: the SQLSTATEs the integrity triggers raise, plus the Postgres ones the app reacts to. */
export const SQLSTATE = {
  CLAIM_LOCKED: 'UC001',
  CLAIM_NOT_EDITABLE: 'UC002',
  TOTAL_IS_DERIVED: 'UC003',
  NO_LINE_ITEMS: 'UC004',
  INVALID_STATUS_TRANSITION: 'UC005',
  ALREADY_DECIDED: 'UC006',
  APPEND_ONLY: 'UC007',
  APPROVER_NOT_ELIGIBLE: 'UC008',
  TOTAL_MISMATCH: 'UC009',
  IMMUTABLE_FIELD: 'UC010',
  APPROVAL_INCOMPLETE: 'UC011',
  CHAIN_INVALID: 'UC012',
  CATEGORY_INACTIVE: 'UC013',
  EXPENSE_DATE_IN_FUTURE: 'UC014',
  AUDIT_EVENT_MISSING: 'UC015',
  SNAPSHOT_MISMATCH: 'UC016',
  CLAIM_HAS_HISTORY: 'UC017',
  STRING_DATA_RIGHT_TRUNCATION: '22001',
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
  FOREIGN_KEY_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  INSUFFICIENT_PRIVILEGE: '42501',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  ADMIN_SHUTDOWN: '57P01',
} as const;

export type KnownSqlState = (typeof SQLSTATE)[keyof typeof SQLSTATE];

const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;
// Prisma engine codes (P1001, P2025, …) and Node errno codes (EPIPE, …) also have five
// characters. Postgres itself only uses class P0 and has no E class, so neither is a SQLSTATE.
const PRISMA_CODE = /^P[1-9][0-9]{3}$/;
const ERRNO_CODE = /^E[A-Z]{4}$/;

const asSqlState = (v: unknown): string | undefined =>
  typeof v === 'string' && SQLSTATE_SHAPE.test(v) && !PRISMA_CODE.test(v) && !ERRNO_CODE.test(v)
    ? v
    : undefined;

const field = (o: unknown, key: string): unknown =>
  o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;

/**
 * Reads the SQLSTATE from every error shape recorded with Prisma 7.10 + @prisma/adapter-pg
 * (docs/reference/sql-proof/README.md §5, harness/out/prisma-error-shapes.json):
 * - model ops (P2039), raw queries (P2010) and unique violations (P2002, which has no `.code`):
 *   `meta.driverAdapterError.cause.originalCode` (also `.code`);
 * - a deferred trigger failing at COMMIT: a raw `DriverAdapterError`, `cause.originalCode`;
 * - node-postgres `DatabaseError` (tests, scripts): `code`.
 */
export function readSqlState(err: unknown): string | undefined {
  const adapterCause = field(field(field(err, 'meta'), 'driverAdapterError'), 'cause');
  const cause = field(err, 'cause');
  return (
    asSqlState(field(adapterCause, 'originalCode')) ??
    asSqlState(field(adapterCause, 'code')) ??
    asSqlState(field(cause, 'originalCode')) ??
    asSqlState(field(cause, 'code')) ??
    asSqlState(field(err, 'code'))
  );
}

/** The Prisma engine error code (`P2002`, `P2034`, …) of a Prisma client error, if any. */
export function prismaCode(err: unknown): string | undefined {
  const code = field(err, 'code');
  return typeof code === 'string' && PRISMA_CODE.test(code) ? code : undefined;
}

export const isPrismaCode = (err: unknown, code: string): boolean => prismaCode(err) === code;
