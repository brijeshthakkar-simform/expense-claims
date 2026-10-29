// TC-I26 (§3.5-c, §6-6): GET /api/v1/finance/claims is FINANCE's read-only view of every
// employee's claims (04 §5.4, §8.3): each row names its claimant; DRAFT appears only when `status`
// asks for it; `dateField` (submittedAt | approvedAt) is both the sort, `<col> DESC, id DESC`, and
// the column `from`/`to` (IST days) filter; keyset pages bind the filters. Backdated submissions
// and decisions are owner SQL (only the owner may supply transition timestamps, D-23).
import { describe, expect, it } from 'vitest';
import * as financeClaimsRoute from '@/app/api/v1/finance/claims/route';
import { todayInBusinessTz } from '@/shared/dates';
import type { ClaimDetail } from '@/shared/dto/claims';
import { FinanceClaimSummaryPage } from '@/shared/dto/finance';
import { asPersona, emailOf, type Persona } from '../../helpers/auth';
import { ownerClient, ownerSql } from '../../helpers/db';
import {
  approveAs,
  makeDraft,
  ownerDecideAt,
  recallAs,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';
import { rawSubmit, tierStep } from '../../helpers/raw-submit';

const PATH = '/api/v1/finance/claims';
const list = (as: Persona | null, query: Record<string, string> = {}) =>
  callRoute(financeClaimsRoute, 'GET', { path: PATH, query, ...(as && { as }) });
async function page(query: Record<string, string> = {}): Promise<FinanceClaimSummaryPage> {
  const res = await list('farah', query);
  expect(res.status, JSON.stringify(query)).toBe(200);
  return FinanceClaimSummaryPage.parse(await res.json()); // the wire contract the client parses with
}
const ids = async (query: Record<string, string> = {}) => (await page(query)).data.map((c) => c.id);

const ALL = { status: 'DRAFT,SUBMITTED,APPROVED,REJECTED' };

/** A fresh SUBMITTED claim of `who`'s for `amountMinor`, through the real services. */
const submitted = async (who: Persona, amountMinor = 500_000, title?: string) =>
  submitAs(who, await makeDraft(who, { title, lines: [{ amountMinor }] }));

/** The level-1 approver of a ≤ ₹10,000 claim (C-15). */
const L1: Partial<Record<Persona, Persona>> = { asha: 'ravi', arjun: 'neha' };

/**
 * A ≤ ₹10,000 claim submitted by the owner at `at` (the C-25 submit order with a supplied
 * submitted_at; the app role's is always now()). Returns the claim as its L1 approver can decide it.
 */
async function submittedAt(who: Persona, at: string, title = `Submitted ${at}`) {
  const draft = await makeDraft(who, { title, lines: [{ amountMinor: 500_000 }] });
  const approver = await asPersona(L1[who]!);
  await rawSubmit(await ownerClient(), draft.id, { chain: [tierStep(1, approver.id)], at });
  return { ...draft, currentRevision: 1 } satisfies Pick<ClaimDetail, 'id' | 'currentRevision'>;
}

/** The expected order straight from the table: `<col> DESC NULLS FIRST, id DESC`. */
async function expectedOrder(col: 'submitted_at' | 'approved_at', where = 'TRUE') {
  const sql = `SELECT id FROM claims WHERE ${where} ORDER BY ${col} DESC NULLS FIRST, id DESC`;
  const { rows } = await (await ownerClient()).query<{ id: string }>(sql);
  return rows.map((r) => r.id);
}

/** Pages through with `limit`: ids in order and the number of pages. */
async function drain(query: Record<string, string>, limit: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p: FinanceClaimSummaryPage = await page({
      ...query,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    expect(p.page.limit).toBe(limit);
    expect(p.data.length).toBeLessThanOrEqual(limit);
    seen.push(...p.data.map((c) => c.id));
    cursor = p.page.nextCursor;
    pages++;
  } while (cursor && pages < 30);
  return { seen, pages };
}

describe('TC-I26 finance list', () => {
  it("lists all employees' claims, excluding DRAFT by default", async () => {
    const neverSubmitted = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    const farahsDraft = await makeDraft('farah');
    const a1 = await submitted('asha', 500_000, 'Cab to client site'); // [ravi]
    const a2 = await approveAs('ravi', await submitted('asha', 800_000, 'Team lunch'));
    const a3 = await rejectAs('ravi', await submitted('asha', 900_000, 'Hotel, Pune'));
    const r1 = await submitted('arjun', 500_000, 'Arjun taxi'); // [neha]
    const v1 = await submitted('vikram', 800_000, 'Vikram travel'); // [deepa, FALLBACK]
    const recalled = await recallAs('asha', await submitted('asha', 300_000)); // DRAFT again

    const p = await page();
    expect(p.page).toEqual({ nextCursor: null, limit: 25 });
    // Newest submission first; every claimant; no DRAFT (never-submitted or recalled)
    expect(p.data.map((c) => c.id)).toEqual([v1.id, r1.id, a3.id, a2.id, a1.id]);
    expect(p.data.map((c) => c.id)).toEqual(
      await expectedOrder('submitted_at', "status <> 'DRAFT'"),
    );
    for (const draft of [neverSubmitted, farahsDraft, recalled])
      expect(p.data.map((c) => c.id)).not.toContain(draft.id);
    // = the explicit default
    expect(await ids({ status: 'SUBMITTED,APPROVED,REJECTED' })).toEqual(p.data.map((c) => c.id));
    expect(await ids({ status: 'REJECTED,SUBMITTED,APPROVED' })).toEqual(p.data.map((c) => c.id));

    // Each row names its claimant (id, name, email)
    const people = { asha: await asPersona('asha'), arjun: await asPersona('arjun') };
    expect(p.data.map((c) => c.claimant.email)).toEqual([
      emailOf('vikram'),
      emailOf('arjun'),
      emailOf('asha'),
      emailOf('asha'),
      emailOf('asha'),
    ]);
    expect(p.data.find((c) => c.id === r1.id)?.claimant).toEqual({
      id: people.arjun.id,
      name: people.arjun.name,
      email: emailOf('arjun'),
    });
    const [db] = await ownerSql<{ created_at: Date; submitted_at: Date; approved_at: Date }>`
      SELECT created_at, submitted_at, approved_at FROM claims WHERE id = ${a2.id}`;
    expect(p.data.find((c) => c.id === a2.id)).toEqual({
      id: a2.id,
      claimNumber: a2.claimNumber,
      title: 'Team lunch',
      status: 'APPROVED',
      currency: 'INR',
      totalMinor: 800_000,
      currentRevision: 1,
      lineItemCount: 1,
      claimant: { id: people.asha.id, name: 'Asha Rao', email: emailOf('asha') },
      createdAt: db!.created_at.toISOString(),
      submittedAt: db!.submitted_at.toISOString(),
      approvedAt: db!.approved_at.toISOString(),
    });
    expect(p.data.find((c) => c.id === a3.id)).toMatchObject({
      status: 'REJECTED',
      approvedAt: null,
      totalMinor: 900_000,
    });
    // Unknown params are refused: there is no claimant filter to widen or narrow the scope with
    const unknownParams: Record<string, string>[] = [
      { claimantId: people.asha.id },
      { employee: 'asha' },
    ];
    for (const query of unknownParams) {
      const res = await list('farah', query);
      expect([query, res.status]).toEqual([query, 422]);
    }
  });

  it('status=DRAFT includes drafts explicitly', async () => {
    const d1 = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    const d2 = await makeDraft('arjun');
    const d3 = await makeDraft('farah'); // finance's own draft is just another claim here
    const s1 = await submitted('asha');
    const recalled = await recallAs('arjun', await submitted('arjun')); // DRAFT, submitted_at kept
    const approved = await approveAs('ravi', await submitted('asha'));

    // Never-submitted drafts (no submitted_at) come first, newest id first; then recalled drafts
    const drafts = await ids({ status: 'DRAFT' });
    expect(drafts).toEqual(await expectedOrder('submitted_at', "status = 'DRAFT'"));
    expect(drafts.slice(0, 3).sort()).toEqual([d1.id, d2.id, d3.id].sort());
    expect(drafts.slice(3)).toEqual([recalled.id]);
    // Drafts and submitted claims together: the NULL block, then submitted_at DESC
    expect(await ids({ status: 'DRAFT,SUBMITTED' })).toEqual([...drafts, s1.id]);
    expect(await ids({ status: 'APPROVED' })).toEqual([approved.id]);
    const all = await ids(ALL);
    expect(all).toEqual(await expectedOrder('submitted_at'));
    expect(all).toHaveLength(6);
    expect(all.slice(0, 3)).toEqual(drafts.slice(0, 3));
    // Paging through the NULL submitted_at block and out of it, one row at a time
    expect((await drain(ALL, 1)).seen).toEqual(all);
    expect((await drain({ status: 'DRAFT' }, 2)).seen).toEqual(drafts);
    // A draft has no approval: dateField=approvedAt never lists one
    expect(await ids({ status: 'DRAFT', dateField: 'approvedAt' })).toEqual([]);
    for (const bad of ['DRAFTS', 'draft', 'DRAFT,', 'PENDING']) {
      const res = await list('farah', { status: bad });
      expect([bad, res.status, (await errorOf(res)).error.code]).toEqual([
        bad,
        422,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('filters by status and by dateField submittedAt or approvedAt', async () => {
    const instants = {
      augLast: '2026-08-31T18:29:59.999Z', // 31 Aug 23:59:59.999 IST
      sepFirst: '2026-08-31T18:30:00.000Z', // 1 Sep 00:00:00.000 IST
      sepLast: '2026-09-30T18:29:59.999Z', // 30 Sep 23:59:59.999 IST
      octFirst: '2026-09-30T18:30:00.000Z', // 1 Oct 00:00:00.000 IST
    };
    type Key = keyof typeof instants;
    const keys = Object.keys(instants) as Key[];
    // S: submitted at the four instants and still SUBMITTED
    const S = {} as Record<Key, string>;
    for (const k of keys) S[k] = (await submittedAt('asha', instants[k], `S ${k}`)).id;
    // A: submitted today, finally approved at the four instants (Arjun's, decided by Neha)
    const A = {} as Record<Key, string>;
    for (const k of keys)
      A[k] = (await ownerDecideAt('neha', await submitted('arjun'), 'APPROVED', instants[k])).id;
    // R: submitted today and rejected; D: a draft
    const R = (await rejectAs('ravi', await submitted('asha'))).id;
    const D = (await makeDraft('asha')).id;

    // status
    expect(await ids({ status: 'SUBMITTED' })).toEqual([
      S.octFirst,
      S.sepLast,
      S.sepFirst,
      S.augLast,
    ]);
    expect(await ids({ status: 'REJECTED' })).toEqual([R]);
    expect((await ids({ status: 'APPROVED' })).sort()).toEqual(Object.values(A).sort());
    expect(await ids({ status: 'SUBMITTED,REJECTED' })).toEqual(
      await expectedOrder('submitted_at', "status IN ('SUBMITTED', 'REJECTED')"),
    );
    expect(await ids({ status: 'DRAFT' })).toEqual([D]);

    // dateField=submittedAt (the default): the submit instant, in IST days
    const sep = { from: '2026-09-01', to: '2026-09-30' };
    expect(await ids(sep)).toEqual([S.sepLast, S.sepFirst]);
    expect(await ids({ ...sep, dateField: 'submittedAt' })).toEqual([S.sepLast, S.sepFirst]);
    expect(await ids({ from: '2026-09-30', to: '2026-09-30' })).toEqual([S.sepLast]);
    expect(await ids({ from: '2026-09-01', to: '2026-09-01' })).toEqual([S.sepFirst]);
    expect(await ids({ to: '2026-08-31' })).toEqual([S.augLast]);
    // A and R were submitted today (S in Aug–1 Oct): from=today lists exactly them
    const today = todayInBusinessTz();
    const submittedToday = await ids({ from: today });
    expect([...submittedToday].sort()).toEqual([...Object.values(A), R].sort());
    expect(submittedToday[0]).toBe(R); // the last one submitted

    // dateField=approvedAt: the FINAL approval instant, newest first; approved claims only
    const byApproval = { dateField: 'approvedAt' };
    expect(await ids(byApproval)).toEqual([A.octFirst, A.sepLast, A.sepFirst, A.augLast]);
    expect(await ids({ ...byApproval, ...sep })).toEqual([A.sepLast, A.sepFirst]);
    expect(await ids({ ...byApproval, from: '2026-10-01' })).toEqual([A.octFirst]);
    expect(await ids({ ...byApproval, to: '2026-08-31' })).toEqual([A.augLast]);
    expect(await ids({ ...byApproval, from: '2026-09-30', to: '2026-09-30' })).toEqual([A.sepLast]);
    // The filter is dateField's own column: A was submitted today, S approved never
    expect(await ids({ ...byApproval, from: today })).toEqual([]);
    expect(await ids({ ...byApproval, status: 'APPROVED' })).toEqual(await ids(byApproval));
    expect(await ids({ ...byApproval, status: 'SUBMITTED,REJECTED' })).toEqual([]); // no approved_at
    expect(await ids({ ...byApproval, ...ALL })).toEqual(await ids(byApproval));

    // Strict query: bad dateField, bad dates, from > to, unknown params → 422
    const bad: Record<string, string>[] = [
      { dateField: 'createdAt' },
      { dateField: 'approved_at' },
      { from: '2026-02-30' },
      { to: '30/09/2026' },
      { from: '2026-09-30', to: '2026-09-01' },
      { limit: '0' },
      { limit: '101' },
      { sort: 'submittedAt:asc' },
    ];
    for (const query of bad) {
      const res = await list('farah', query);
      expect([query, res.status, (await errorOf(res)).error.code]).toEqual([
        query,
        422,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('a non-finance user gets 403 FORBIDDEN', async () => {
    await submitted('asha'); // there is something to list
    for (const who of ['asha', 'ravi', 'meera', 'neha', 'deepa', 'admin'] as const) {
      const res = await list(who);
      const body = await errorOf(res);
      expect([who, res.status, body.error.code]).toEqual([who, 403, 'FORBIDDEN']);
      expect(body).not.toHaveProperty('data');
    }
    // the role gate runs before query validation: a bad query is still 403 for them
    const bad = await list('asha', { dateField: 'nope' });
    expect([bad.status, (await errorOf(bad)).error.code]).toEqual([403, 'FORBIDDEN']);
    // no session at all is 401
    const anon = await list(null);
    expect([anon.status, (await errorOf(anon)).error.code]).toEqual([401, 'UNAUTHENTICATED']);
    // and FINANCE gets the list
    expect((await list('farah')).status).toBe(200);
  });

  it('keyset completeness with ties', async () => {
    // Ties on submitted_at (3 owner submits at one instant, 2 at another), on approved_at
    // (3 final approvals at one instant), and the NULL submitted_at block of never-submitted drafts
    const tieS = '2026-09-10T04:30:00.000Z';
    const tieA = '2026-09-20T04:30:00.000Z';
    const sub = [tieS, tieS, tieS, '2026-09-12T04:30:00.000Z', '2026-09-12T04:30:00.000Z'];
    for (const at of sub) await submittedAt('asha', at);
    for (const at of [tieA, tieA, tieA, '2026-09-21T04:30:00.000Z'])
      await ownerDecideAt(
        'ravi',
        await submittedAt('asha', '2026-09-05T04:30:00.000Z'),
        'APPROVED',
        at,
      );
    await rejectAs('neha', await submittedAt('arjun', tieS));
    for (let i = 0; i < 3; i++) await makeDraft(i === 1 ? 'arjun' : 'asha');
    await submitted('arjun'); // submitted now

    const cases: { query: Record<string, string>; expected: string[] }[] = [
      { query: {}, expected: await expectedOrder('submitted_at', "status <> 'DRAFT'") },
      { query: ALL, expected: await expectedOrder('submitted_at') },
      {
        query: { from: '2026-09-01', to: '2026-09-30' },
        expected: await expectedOrder(
          'submitted_at',
          "status <> 'DRAFT' AND submitted_at >= '2026-08-31T18:30:00Z' AND submitted_at < '2026-09-30T18:30:00Z'",
        ),
      },
      {
        query: { dateField: 'approvedAt' },
        expected: await expectedOrder('approved_at', "status = 'APPROVED'"),
      },
      {
        query: { status: 'SUBMITTED' },
        expected: await expectedOrder('submitted_at', "status = 'SUBMITTED'"),
      },
    ];
    expect(cases[0]!.expected).toHaveLength(11);
    expect(cases[1]!.expected).toHaveLength(14);
    expect(cases[3]!.expected).toHaveLength(4);
    for (const { query, expected } of cases) {
      for (const limit of [1, 2, 3, 5]) {
        const { seen, pages } = await drain(query, limit);
        expect([query, limit, seen]).toEqual([query, limit, expected]); // complete, disjoint, ordered
        expect(new Set(seen).size).toBe(seen.length);
        expect(pages).toBe(Math.max(1, Math.ceil(expected.length / limit)));
      }
    }

    // A cursor is bound to its sort and filters (not to limit), and can't be forged
    const first = await page({ limit: '2' });
    const next = first.page.nextCursor!;
    expect((await list('farah', { cursor: next, limit: '7' })).status).toBe(200);
    const stale: Record<string, string>[] = [
      { cursor: next, dateField: 'approvedAt' }, // a submittedAt cursor on the approvedAt sort
      { cursor: next, status: 'SUBMITTED' },
      { cursor: next, ...ALL },
      { cursor: next, from: '2026-09-01' },
      { cursor: 'bm9wZQ' },
    ];
    for (const query of stale) {
      const res = await list('farah', query);
      expect([query, res.status, (await errorOf(res)).error.code]).toEqual([
        query,
        422,
        'INVALID_CURSOR',
      ]);
    }
  });
});
