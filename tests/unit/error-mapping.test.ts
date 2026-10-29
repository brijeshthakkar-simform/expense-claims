// TC-U08 (§6-2, RT-B1(d)): mapError is the only place an exception becomes a status (04 §9.1). DB
// errors map by SQLSTATE only, read from every error shape Prisma 7.10 + adapter-pg was recorded
// throwing on a real PostgreSQL (docs/reference/sql-proof, prisma-error-shapes.json).
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { readSqlState, SQLSTATE } from '@/server/db/pg-error';
import { AppError } from '@/server/errors/app-error';
import { ERROR_CATALOGUE, type ErrorCode } from '@/server/errors/codes';
import { errorBody, isDbBackstop, mapError } from '@/server/errors/map-error';
import { LoginInput } from '@/shared/schemas/auth';
import { DriverAdapterError, recordedErrorShapes, uc012 } from '../helpers/prisma-shapes';

/** A node-postgres DatabaseError as the pg driver builds it (tests, scripts, raw attacks). */
function pgError(code: string, message = 'refused', constraint?: string) {
  const err = new pg.DatabaseError(message, message.length, 'error');
  err.code = code;
  err.constraint = constraint;
  return err;
}

/** The P2039 model-op shape: SQLSTATE in meta.driverAdapterError.cause. */
const prismaModelError = (sqlState: string) =>
  new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${sqlState}\``, {
    code: 'P2039',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Claim',
      driverAdapterError: new DriverAdapterError({
        code: sqlState,
        kind: 'postgres',
        originalCode: sqlState,
        originalMessage: `${sqlState}: refused`,
      }),
    },
  });

// 04 §9.3. UC007–UC012, UC015 and UC016 mean our code has a bug: 500, logged as db.backstop.
const UC_TABLE: Record<string, [ErrorCode, number, Record<string, unknown>?]> = {
  UC001: ['CLAIM_LOCKED', 409, { status: 'APPROVED' }],
  UC002: ['CLAIM_NOT_EDITABLE', 409, { hint: 'RECALL_TO_EDIT' }],
  UC003: ['TOTAL_IS_DERIVED', 422],
  UC004: ['NO_LINE_ITEMS', 422],
  UC005: ['INVALID_STATUS_TRANSITION', 409],
  UC006: ['ALREADY_DECIDED', 409],
  UC007: ['INTERNAL_ERROR', 500],
  UC008: ['INTERNAL_ERROR', 500],
  UC009: ['INTERNAL_ERROR', 500],
  UC010: ['INTERNAL_ERROR', 500],
  UC011: ['INTERNAL_ERROR', 500],
  UC012: ['INTERNAL_ERROR', 500],
  UC013: ['CATEGORY_INACTIVE', 422],
  UC014: ['VALIDATION_FAILED', 422, { issues: [expect.objectContaining({ path: ['lineItems'] })] }],
  UC015: ['INTERNAL_ERROR', 500],
  UC016: ['INTERNAL_ERROR', 500],
  UC017: ['CLAIM_HAS_HISTORY', 409],
};

// The PostgreSQL rows of the same table.
const PG_TABLE: Record<string, [ErrorCode, number]> = {
  '23514': ['VALIDATION_FAILED', 422],
  '23503': ['VALIDATION_FAILED', 422],
  '22003': ['VALIDATION_FAILED', 422],
  '22001': ['VALIDATION_FAILED', 422],
  '23505': ['CONFLICT', 409],
  '40001': ['CONFLICT', 409],
  '40P01': ['CONFLICT', 409],
  '55P03': ['CONFLICT', 409],
  '57014': ['SERVICE_UNAVAILABLE', 503],
  '57P01': ['SERVICE_UNAVAILABLE', 503],
  '08006': ['SERVICE_UNAVAILABLE', 503],
  '42501': ['INTERNAL_ERROR', 500],
};

describe('TC-U08 error mapping', () => {
  it('maps every UC SQLSTATE to its catalogue code and status', () => {
    const ucCodes = Object.values(SQLSTATE).filter((s) => s.startsWith('UC'));
    expect(Object.keys(UC_TABLE).sort()).toEqual([...ucCodes].sort()); // the table covers all 17

    for (const [sqlState, [code, status, details]] of Object.entries(UC_TABLE)) {
      // The same answer whether the trigger error arrives through pg or through Prisma.
      for (const err of [pgError(sqlState), prismaModelError(sqlState)]) {
        const e = mapError(err);
        expect([sqlState, e.code, e.status]).toEqual([sqlState, code, status]);
        expect(ERROR_CATALOGUE[e.code].status).toBe(status);
        if (details) expect(e.details).toEqual(details);
        expect(e.cause).toBe(err); // the original stays attached for the log line
      }
      expect(isDbBackstop(sqlState)).toBe(true); // every UC refusal is logged as db.backstop
    }

    for (const [sqlState, [code, status]] of Object.entries(PG_TABLE)) {
      const e = mapError(pgError(sqlState));
      expect([sqlState, e.code, e.status]).toEqual([sqlState, code, status]);
    }
    const check = mapError(pgError('23514', 'violates check', 'line_items_amount_range'));
    expect(check.details).toEqual({ constraint: 'line_items_amount_range' });
    expect(mapError(pgError('40P01')).details).toEqual({ retryable: true });
  });

  it('reads SQLSTATE from Prisma P2039/P2010 meta, from a commit-time DriverAdapterError and from pg errors', () => {
    const shapes = recordedErrorShapes();
    expect(shapes).toHaveLength(11);
    expect(new Set(shapes.map((s) => s.code ?? s.ctor))).toEqual(
      new Set(['P2039', 'P2010', 'P2002', 'DriverAdapterError']),
    );

    for (const s of shapes) {
      const err =
        s.ctor === 'DriverAdapterError'
          ? new DriverAdapterError(s.cause!)
          : new Prisma.PrismaClientKnownRequestError(s.message, {
              code: s.code!,
              clientVersion: '7.10.0',
              meta: {
                ...(s.metaModelName && { modelName: s.metaModelName }),
                driverAdapterError: new DriverAdapterError(s.driverAdapterError_cause!),
              },
            });
      expect([s.label, readSqlState(err)]).toEqual([s.label, s.expected]);
      expect(s.readSqlState).toBe(s.expected); // what the proof itself read
    }

    // P2002 carries no `.code` on its cause, only originalCode; it is a unique race → 409.
    const p2002 = shapes.find((s) => s.code === 'P2002')!;
    expect(p2002.driverAdapterError_cause!.code).toBeUndefined();
    // Deferred triggers fail at COMMIT as a raw DriverAdapterError (UC015 recorded, UC009 alike).
    expect(mapError(new DriverAdapterError(shapes.at(-1)!.cause!)).code).toBe('INTERNAL_ERROR');
    expect(readSqlState(uc012())).toBe('UC012');

    // node-postgres
    expect(readSqlState(pgError('UC001'))).toBe('UC001');
    expect(readSqlState(pgError('40P01'))).toBe('40P01');

    // Engine codes and errno strings are not SQLSTATEs, and junk reads as nothing.
    for (const notASqlState of [
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '7.10.0',
      }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      Object.assign(new Error('closed'), { code: 'P1017' }),
      { code: 'uc001' },
      'UC001',
      null,
      undefined,
    ])
      expect(readSqlState(notASqlState)).toBeUndefined();
  });

  it('ZodError maps to 422 VALIDATION_FAILED with issues[].path', () => {
    const typed = 'not-an-email@@';
    const login = LoginInput.safeParse({ email: typed, password: '' });
    const e = mapError(login.error);

    expect([e.code, e.status]).toEqual(['VALIDATION_FAILED', 422]);
    const issues = (e.details as { issues: { path: unknown[]; message: string; code: string }[] })
      .issues;
    expect(issues.map((i) => i.path)).toEqual([['email'], ['password']]);
    for (const i of issues)
      expect(i).toEqual({ path: i.path, message: expect.any(String), code: expect.any(String) });
    expect(JSON.stringify(e.details)).not.toContain(typed); // never echoes the input

    // Array indexes stay numbers, so a form can map the issue onto line 2's amount.
    const Lines = z.strictObject({
      lineItems: z.array(z.strictObject({ amountMinor: z.number().int().positive() })),
    });
    const nested = mapError(
      Lines.safeParse({ lineItems: [{ amountMinor: 1 }, { amountMinor: -5 }] }).error,
    );
    expect(nested.details).toMatchObject({ issues: [{ path: ['lineItems', 1, 'amountMinor'] }] });

    // Unknown keys: a total-like key beats a server-owned key beats everything else (04 §10.1).
    const Title = z.strictObject({ title: z.string() });
    const codeFor = (body: object) => mapError(Title.safeParse(body).error).code;
    expect(codeFor({ title: 'x', totalMinor: 1, status: 'APPROVED' })).toBe('TOTAL_IS_DERIVED');
    expect(codeFor({ title: 'x', status: 'APPROVED' })).toBe('READ_ONLY_FIELD');
    expect(codeFor({ title: 'x', colour: 'red' })).toBe('VALIDATION_FAILED');
    expect(mapError(Title.safeParse({ title: 'x', total: 5 }).error).details).toEqual({
      issues: [
        { path: ['total'], code: 'unrecognized_keys', message: 'This field is set by the server' },
      ],
    });

    // A refinement can promote itself to a specific 422 code.
    const Range = z.string().refine(() => false, { params: { code: 'EXPORT_RANGE_TOO_LARGE' } });
    expect(mapError(Range.safeParse('x').error)).toMatchObject({
      code: 'EXPORT_RANGE_TOO_LARGE',
      status: 422,
    });
  });

  it('unknown errors map to 500 INTERNAL_ERROR without internals', () => {
    const requestId = 'req-0f6c2a1e';
    const generic = {
      error: {
        code: 'INTERNAL_ERROR',
        message: `Something went wrong. Quote reference ${requestId}.`,
        requestId,
      },
    };
    const sqlLeak = new TypeError('query failed: SELECT password_hash FROM users');
    for (const err of [
      sqlLeak,
      new RangeError('Maximum call stack size exceeded'),
      Object.assign(new Error('engine'), { code: 'P9999' }),
      uc012(), // a backstop is a 500 too: our code has a bug, the data is safe
      'a thrown string',
      { weird: true },
      null,
      undefined,
    ]) {
      const e = mapError(err);
      expect([e.code, e.status]).toEqual(['INTERNAL_ERROR', 500]);
      expect(errorBody(e, requestId)).toEqual(generic); // no details, stack, SQL or message
    }
    expect(mapError(sqlLeak).cause).toBe(sqlLeak); // kept for the log line only

    // Connection-class Prisma codes are 503, conflicts 409; the 5xx body stays generic.
    for (const code of ['P1001', 'P1017', 'P2024'])
      expect(mapError({ code }).code).toBe('SERVICE_UNAVAILABLE');
    for (const code of ['P2002', 'P2034']) expect(mapError({ code }).code).toBe('CONFLICT');
    const leaky = new AppError('SERVICE_UNAVAILABLE', 'pool exhausted on db.internal', {
      host: 'db',
    });
    expect(errorBody(leaky, requestId)).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: `Service temporarily unavailable. Quote reference ${requestId}.`,
        requestId,
      },
    });
  });
});
