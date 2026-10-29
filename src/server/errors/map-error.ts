import 'server-only';
import { z } from 'zod';
import { prismaCode, readSqlState, SQLSTATE } from '@/server/db/pg-error';
import { AppError, type ErrorDetails } from '@/server/errors/app-error';
import { ERROR_CATALOGUE, isErrorCode, type ErrorCode } from '@/server/errors/codes';
import { CursorError } from '@/shared/cursor';
import type { ApiIssue } from '@/shared/errors';

// 04 §10.2: body keys the server owns. A total-like key wins over the others.
const TOTAL_KEYS = new Set(['totalMinor', 'total', 'total_minor']);
const READ_ONLY_KEYS = new Set([
  'id',
  'status',
  'claimantId',
  'claimNumber',
  'currency',
  'currentRevision',
  'submittedAt',
  'approvedAt',
  'rejectedAt',
  'createdAt',
  'updatedAt',
  'allowedActions',
  'approval',
  'claimId',
  'receipts',
]);

/**
 * The ONLY place an exception becomes a status code (04 §9.1). AppErrors pass through; Zod issues
 * become 422s; database errors are mapped by SQLSTATE (C-05), then by Prisma engine code, never by
 * message text. Anything else is a 500 that keeps the original error as `cause` for the log only.
 */
export function mapError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) return fromZod(err);
  if (err instanceof CursorError)
    return new AppError('INVALID_CURSOR', undefined, undefined, { cause: err });
  const sqlState = readSqlState(err);
  if (sqlState) return fromSqlState(sqlState, err);
  switch (prismaCode(err) ?? 'none') {
    case 'P2002': // unique violation without a readable SQLSTATE
    case 'P2034': // write conflict / deadlock
      return new AppError('CONFLICT', undefined, { retryable: true }, { cause: err });
    case 'P1001':
    case 'P1017':
    case 'P2024':
      return new AppError('SERVICE_UNAVAILABLE', undefined, undefined, { cause: err });
    default:
      return new AppError('INTERNAL_ERROR', undefined, undefined, { cause: err });
  }
}

/** C-05 / 04 §9.3. UC007–UC012, UC015, UC016 mean our code has a bug: 500, logged as db.backstop. */
export function fromSqlState(sqlState: string, err?: unknown): AppError {
  const as = (code: ErrorCode, details?: ErrorDetails) =>
    new AppError(code, undefined, details, { cause: err });
  switch (sqlState) {
    case SQLSTATE.CLAIM_LOCKED:
      return as('CLAIM_LOCKED', { status: 'APPROVED' });
    case SQLSTATE.CLAIM_NOT_EDITABLE:
      return as('CLAIM_NOT_EDITABLE', { hint: 'RECALL_TO_EDIT' });
    case SQLSTATE.TOTAL_IS_DERIVED:
      return as('TOTAL_IS_DERIVED');
    case SQLSTATE.NO_LINE_ITEMS:
      return as('NO_LINE_ITEMS');
    case SQLSTATE.INVALID_STATUS_TRANSITION:
      return as('INVALID_STATUS_TRANSITION');
    case SQLSTATE.ALREADY_DECIDED:
      return as('ALREADY_DECIDED');
    case SQLSTATE.CATEGORY_INACTIVE:
      return as('CATEGORY_INACTIVE');
    case SQLSTATE.EXPENSE_DATE_IN_FUTURE:
      return as('VALIDATION_FAILED', {
        issues: [
          {
            path: ['lineItems'],
            message: 'Expense date cannot be in the future (IST)',
            code: 'custom',
          },
        ] satisfies ApiIssue[],
      });
    case SQLSTATE.CLAIM_HAS_HISTORY:
      return as('CLAIM_HAS_HISTORY');
    case SQLSTATE.CHECK_VIOLATION: {
      const constraint = readConstraint(err);
      return as('VALIDATION_FAILED', constraint ? { constraint } : undefined);
    }
    case SQLSTATE.FOREIGN_KEY_VIOLATION:
    case SQLSTATE.NUMERIC_VALUE_OUT_OF_RANGE:
    case SQLSTATE.STRING_DATA_RIGHT_TRUNCATION:
      return as('VALIDATION_FAILED');
    case SQLSTATE.UNIQUE_VIOLATION:
    case SQLSTATE.SERIALIZATION_FAILURE: // withTx has already retried twice
    case SQLSTATE.DEADLOCK_DETECTED:
    case SQLSTATE.LOCK_NOT_AVAILABLE:
      return as('CONFLICT', { retryable: true });
    case SQLSTATE.QUERY_CANCELED:
    case SQLSTATE.ADMIN_SHUTDOWN:
      return as('SERVICE_UNAVAILABLE');
    default:
      // 08xxx = connection exceptions. Everything else (UC007–UC012, UC015, UC016, 42501, …) is
      // a refusal the service should never have provoked.
      return as(sqlState.startsWith('08') ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR');
  }
}

/**
 * SQLSTATEs where the database itself refused a write the service should already have refused
 * (triggers, CHECK/FK/overflow backstops, privileges). When one surfaces through the API it is
 * logged as `db.backstop` at error with `defense: 'db'` (D-40, C-19): the data is safe, the code
 * has a bug.
 */
export function isDbBackstop(sqlState: string | undefined): sqlState is string {
  if (!sqlState) return false;
  return (
    sqlState.startsWith('UC') ||
    sqlState === SQLSTATE.CHECK_VIOLATION ||
    sqlState === SQLSTATE.FOREIGN_KEY_VIOLATION ||
    sqlState === SQLSTATE.NUMERIC_VALUE_OUT_OF_RANGE ||
    sqlState === SQLSTATE.STRING_DATA_RIGHT_TRUNCATION ||
    sqlState === SQLSTATE.INSUFFICIENT_PRIVILEGE
  );
}

function fromZod(err: z.ZodError): AppError {
  const unknownKeys = err.issues.flatMap((i) =>
    i.code === 'unrecognized_keys' ? i.keys.map((k) => [...i.path, k]) : [],
  );
  const issuesFor = (set: Set<string>): ApiIssue[] =>
    unknownKeys
      .filter((p) => set.has(String(p.at(-1))))
      .map((path) => ({
        path: path.map(toPathSegment),
        code: 'unrecognized_keys',
        message: 'This field is set by the server',
      }));

  const totals = issuesFor(TOTAL_KEYS);
  if (totals.length) return new AppError('TOTAL_IS_DERIVED', undefined, { issues: totals });
  const readOnly = issuesFor(READ_ONLY_KEYS);
  if (readOnly.length) return new AppError('READ_ONLY_FIELD', undefined, { issues: readOnly });

  // A refinement can promote itself to a specific catalogue code via params.code
  // (EXPORT_RANGE_TOO_LARGE, EXPORT_STATUS_NOT_ALLOWED).
  for (const i of err.issues) {
    const code: unknown = i.code === 'custom' ? i.params?.code : undefined;
    if (isErrorCode(code) && ERROR_CATALOGUE[code].status === 422)
      return new AppError(code, i.message);
  }

  // Never echoes the input: only path, message and issue code.
  const issues: ApiIssue[] = err.issues.map((i) => ({
    path: i.path.map(toPathSegment),
    message: i.message,
    code: i.code,
  }));
  return new AppError('VALIDATION_FAILED', undefined, { issues });
}

const toPathSegment = (p: PropertyKey): string | number => (typeof p === 'number' ? p : String(p));

/** The CHECK constraint name from a pg error or a Prisma adapter error, for `details.constraint`. */
function readConstraint(err: unknown): string | undefined {
  const field = (o: unknown, key: string): unknown =>
    o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
  const direct = field(err, 'constraint');
  if (typeof direct === 'string') return direct;
  const cause =
    field(field(field(err, 'meta'), 'driverAdapterError'), 'cause') ?? field(err, 'cause');
  const message = field(cause, 'originalMessage');
  // Display detail only; the mapping above never looks at message text.
  const match = typeof message === 'string' ? /constraint "([\w-]+)"/.exec(message) : null;
  return match?.[1];
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetails; requestId: string };
}

/**
 * The C-08 error envelope. 5xx bodies are always the catalogue's generic message plus the
 * reference, in every environment: no details, stack, Prisma text or SQL (04 §9.1).
 */
export function errorBody(e: AppError, requestId: string): ErrorBody {
  if (e.status >= 500) {
    const message = `${ERROR_CATALOGUE[e.code].message} Quote reference ${requestId}.`;
    return { error: { code: e.code, message, requestId } };
  }
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined && { details: e.details }),
      requestId,
    },
  };
}
