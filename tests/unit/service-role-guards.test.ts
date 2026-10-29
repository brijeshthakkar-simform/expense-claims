// TC-U09 (§3.5-c, RT-M11): the finance and export services guard themselves. requireRole(actor,
// 'FINANCE') is the first line of every function, so a caller that skips the route's role gate (an
// RSC page, a script) still gets 403 FORBIDDEN, before any query. The database client is replaced
// by a tripwire: getDb() is recorded, and any method called on the client it returns throws.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import { AppError } from '@/server/errors/app-error';
import { financeClaimsWhere } from '@/server/repositories/claim-visibility';
import * as exportRepo from '@/server/repositories/export.repo';
import * as financeRepo from '@/server/repositories/finance.repo';
import type { ServiceCtx } from '@/server/services/context';
import * as exportService from '@/server/services/export.service';
import * as financeService from '@/server/services/finance.service';
import { FinanceClaimsQuery } from '@/shared/schemas/queries';

const TRIPWIRE = 'TRIPWIRE: a query reached the database client';
const query = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('TRIPWIRE: a query reached the database client');
  }),
);
vi.mock('@/server/db/client', () => ({
  // Any client method ($queryRaw, claim.findFirst's `claim`, …) is the throwing spy
  getDb: vi.fn(() => new Proxy({}, { get: () => query })),
}));

const actor = (o: Partial<Actor>): Actor => ({
  id: '0199c0de-0000-7000-8000-000000000001',
  email: 'someone@acme.test',
  name: 'Someone',
  role: 'EMPLOYEE',
  canApprove: false,
  ...o,
});
const NON_FINANCE: Record<string, Actor> = {
  employee: actor({ email: 'asha.rao@acme.test' }),
  approver: actor({ email: 'ravi.menon@acme.test', canApprove: true }),
  admin: actor({ email: 'admin@acme.test', role: 'ADMIN' }),
  'admin who can approve': actor({ role: 'ADMIN', canApprove: true }),
};
const FINANCE = actor({ email: 'farah.khan@acme.test', role: 'FINANCE' });
const ctx = (a: Actor): ServiceCtx => ({ actor: a, requestId: 'test-role-guards' });

/** The settled outcome of `fn`: a sync throw and an async rejection alike. */
async function outcome(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return 'resolved';
  } catch (err) {
    return err;
  }
}
const codeOf = (err: unknown) => (err instanceof AppError ? [err.code, err.status] : err);

const sep = { from: '2026-09-01', to: '2026-09-30' };
type Call = [name: string, run: (a: Actor) => unknown];

/** Every exported function of the two services. */
const SERVICE_CALLS: Call[] = [
  [
    'listFinanceClaims',
    (a) => financeService.listFinanceClaims(ctx(a), FinanceClaimsQuery.parse({})),
  ],
  [
    'listFinanceClaims (approvedAt, DRAFT)',
    (a) =>
      financeService.listFinanceClaims(
        ctx(a),
        FinanceClaimsQuery.parse({ status: 'DRAFT', dateField: 'approvedAt' }),
      ),
  ],
  ['openApprovedClaimsExport', (a) => exportService.openApprovedClaimsExport(ctx(a), sep)],
  // the role check precedes validation: a bad period still says FORBIDDEN to a non-finance actor
  [
    'openApprovedClaimsExport (from > to)',
    (a) => exportService.openApprovedClaimsExport(ctx(a), { from: '2026-09-30', to: '2026-09-01' }),
  ],
  [
    'openApprovedClaimsExport (status=REJECTED)',
    (a) => exportService.openApprovedClaimsExport(ctx(a), { ...sep, status: 'REJECTED' }),
  ],
];

/** The repositories behind them refuse again (defence in depth): no statement is ever sent. */
const REPO_CALLS: Call[] = [
  [
    'financeRepo.listForFinance',
    (a) =>
      financeRepo.listForFinance(a, {
        statuses: ['SUBMITTED'],
        dateField: 'submittedAt',
        range: {},
        take: 26,
      }),
  ],
  [
    'exportRepo.approvedClaimsBatch',
    (a) =>
      exportRepo.approvedClaimsBatch(a, {
        gte: new Date('2026-08-31T18:30:00.000Z'),
        lt: new Date('2026-09-30T18:30:00.000Z'),
        asOf: new Date(),
        after: null,
        limit: 3,
      }),
  ],
];

beforeEach(() => {
  vi.mocked(getDb).mockClear();
  query.mockClear();
});

describe('TC-U09 service role guards', () => {
  it('finance and export services throw FORBIDDEN for a non-finance actor before touching the database', async () => {
    for (const [who, a] of Object.entries(NON_FINANCE)) {
      for (const [name, run] of SERVICE_CALLS)
        expect([who, name, codeOf(await outcome(() => run(a)))]).toEqual([
          who,
          name,
          ['FORBIDDEN', 403],
        ]);
    }
    expect(getDb).not.toHaveBeenCalled(); // the services never even reached for the client

    for (const [who, a] of Object.entries(NON_FINANCE)) {
      for (const [name, run] of REPO_CALLS)
        expect([who, name, codeOf(await outcome(() => run(a)))]).toEqual([
          who,
          name,
          ['FORBIDDEN', 403],
        ]);
    }
    expect(query).not.toHaveBeenCalled(); // no statement was sent

    // Positive control: FINANCE passes every guard and reaches the database (the tripwire)
    const plain = ([name]: Call) => !name.includes('(');
    for (const [name, run] of [...SERVICE_CALLS.filter(plain), ...REPO_CALLS]) {
      const err = await outcome(() => run(FINANCE));
      expect([name, (err as Error).message]).toEqual([name, TRIPWIRE]);
    }
    expect(query).toHaveBeenCalledTimes(4);
    // ...and gets the same validation errors as the route for a bad period (re-parsed, no query)
    query.mockClear();
    const backwards = await outcome(() =>
      exportService.openApprovedClaimsExport(ctx(FINANCE), {
        from: '2026-09-30',
        to: '2026-09-01',
      }),
    );
    expect(backwards).toMatchObject({ name: 'ZodError' });
    expect(query).not.toHaveBeenCalled();
  });

  it('financeClaimsWhere throws FORBIDDEN unless the actor is FINANCE', async () => {
    for (const [who, a] of Object.entries(NON_FINANCE)) {
      expect([who, codeOf(await outcome(() => financeClaimsWhere(a)))]).toEqual([
        who,
        ['FORBIDDEN', 403],
      ]);
      // the list statement is built through it, so none can be built for them either
      const built = await outcome(() =>
        financeRepo.financeListSql(a, {
          statuses: ['APPROVED'],
          dateField: 'approvedAt',
          range: {},
          take: 26,
        }),
      );
      expect([who, codeOf(built)]).toEqual([who, ['FORBIDDEN', 403]]);
    }
    // FINANCE reads every claim: for them the scope is no restriction at all
    expect(financeClaimsWhere(FINANCE).sql).toBe('TRUE');
    expect(financeService.financeClaimsWhere).toBe(financeClaimsWhere); // one implementation
    const sql = financeRepo.financeListSql(FINANCE, {
      statuses: ['SUBMITTED', 'APPROVED', 'REJECTED'],
      dateField: 'submittedAt',
      range: {},
      take: 26,
    });
    expect(sql.sql).toMatch(/WHERE TRUE AND /); // the scope is the first conjunct
    expect(getDb).not.toHaveBeenCalled(); // building a statement is not running it
  });
});
