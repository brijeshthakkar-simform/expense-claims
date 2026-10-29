// TC-I25 (§3.2-c, §3.5-b, §6-6): GET /api/v1/approvals is a query over MY steps (04 §5.4): the
// Pending tab lists my PENDING steps oldest first (activated_at ASC, id ASC), the Decided tab my
// APPROVED/REJECTED steps newest first (decided_at DESC, id DESC). WAITING and CANCELLED steps, and
// everyone else's, are never listed. from/to are IST days on the tab's own column. Backdated
// decisions (and the next level's activated_at) come from ownerDecideAt: only the owner may supply
// transition timestamps (D-23).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as approvalsRoute from '@/app/api/v1/approvals/route';
import * as approvalsService from '@/server/services/approvals.service';
import { todayInBusinessTz } from '@/shared/dates';
import { ApprovalTaskPage } from '@/shared/dto/approvals';
import type { ClaimDetail } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { captureQueries, ownerSql } from '../../helpers/db';
import {
  approveAs,
  ctx,
  makeDraft,
  ownerDecideAt,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const list = (as: Persona, query: Record<string, string> = {}) =>
  callRoute(approvalsRoute, 'GET', { path: '/api/v1/approvals', as, query });
async function page(as: Persona, query: Record<string, string> = {}): Promise<ApprovalTaskPage> {
  const res = await list(as, query);
  expect(res.status, JSON.stringify(query)).toBe(200);
  return ApprovalTaskPage.parse(await res.json()); // the wire contract the client parses with
}
/** Claim ids in list order. */
const queue = async (as: Persona, query: Record<string, string> = {}) =>
  (await page(as, query)).data.map((t) => t.claimId);
const DECIDED = { status: 'APPROVED,REJECTED' };

/** A fresh SUBMITTED claim of `who`'s for `amountMinor`. */
const submitted = async (amountMinor: number, who: Persona = 'asha', title?: string) =>
  submitAs(who, await makeDraft(who, { title, lines: [{ amountMinor }] }));

describe('TC-I25 approver queue', () => {
  it('default lists only my PENDING steps, oldest first', async () => {
    const a = await submitted(800_000, 'asha', 'Cab to client site'); // [ravi]
    const b = await submitted(2_500_000, 'asha', 'Client workshop, Pune'); // [ravi, meera]
    const c = await submitted(900_000); // [ravi]
    await submitted(500_000, 'arjun'); // [neha]: never Ravi's

    const p = await page('ravi');
    expect(p.data.map((t) => t.claimId)).toEqual([a.id, b.id, c.id]); // oldest first
    expect(p.page).toEqual({ nextCursor: null, limit: 25 });
    expect(await queue('ravi', { status: 'PENDING' })).toEqual([a.id, b.id, c.id]); // = the default

    const asha = await asPersona('asha');
    const [stepB] = await ownerSql<{ id: string; activated_at: Date }>`
      SELECT id, activated_at FROM approval_steps WHERE claim_id = ${b.id} AND level = 1`;
    expect(p.data[1]).toEqual({
      stepId: stepB!.id,
      claimId: b.id,
      claimNumber: b.claimNumber,
      title: 'Client workshop, Pune',
      claimant: { id: asha.id, name: 'Asha Rao' },
      revision: 1,
      level: 1,
      levelCount: 2,
      tierLabel: 'Line manager',
      amountMinor: 2_500_000,
      currency: 'INR',
      status: 'PENDING',
      activatedAt: stepB!.activated_at.toISOString(),
      decidedAt: null,
    });
    const times = p.data.map((t) => Date.parse(t.activatedAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));

    // a decision takes the row off my Pending tab (and onto Decided)
    await approveAs('ravi', a);
    expect(await queue('ravi')).toEqual([b.id, c.id]);
    expect(await queue('ravi', DECIDED)).toEqual([a.id]);
  });

  it('never lists claims routed to other approvers or WAITING steps', async () => {
    const two = await submitted(2_500_000); // [ravi PENDING, meera WAITING]
    const three = await submitted(7_500_000); // [ravi PENDING, meera WAITING, vikram WAITING]
    const arjuns = await submitted(500_000, 'arjun'); // [neha]

    expect(await queue('meera')).toEqual([]); // WAITING is not "routed to me" yet
    expect(await queue('vikram')).toEqual([]);
    expect(await queue('meera', DECIDED)).toEqual([]);
    expect(await queue('ravi')).toEqual([two.id, three.id]);
    expect(await queue('neha')).toEqual([arjuns.id]); // positive control: her own queue works
    for (const p of ['neha', 'deepa'] as const) {
      expect(await queue(p, DECIDED)).toEqual([]);
    }

    // routed to Meera once Ravi approves level 1
    await approveAs('ravi', two);
    expect(await queue('meera')).toEqual([two.id]);
    expect(await queue('neha')).toEqual([arjuns.id]); // still nothing of Asha's

    // a rejection at level 1 CANCELS the later steps: never listed, on either tab
    await rejectAs('ravi', three);
    const cancelled = await ownerSql<{ status: string }>`
      SELECT status::text FROM approval_steps WHERE claim_id = ${three.id} AND level > 1`;
    expect(cancelled).toEqual([{ status: 'CANCELLED' }, { status: 'CANCELLED' }]);
    expect(await queue('meera')).toEqual([two.id]);
    expect(await queue('meera', DECIDED)).toEqual([]);
    expect(await queue('vikram')).toEqual([]);
    expect(await queue('vikram', DECIDED)).toEqual([]);

    // the scope is not a parameter: there is nothing to widen it with
    const widen = await list('meera', { approverId: (await asPersona('ravi')).id });
    expect([widen.status, (await errorOf(widen)).error.code]).toEqual([422, 'VALIDATION_FAILED']);
    for (const status of ['WAITING', 'CANCELLED', 'PENDING,APPROVED', 'PENDING,WAITING']) {
      const res = await list('ravi', { status });
      expect([status, res.status, (await errorOf(res)).error.code]).toEqual([
        status,
        422,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('status=APPROVED,REJECTED lists my decided steps newest first', async () => {
    const a = await submitted(800_000); // [ravi]
    const b = await submitted(1_200_000); // [ravi, meera]
    const c = await submitted(2_500_000); // [ravi, meera]
    await approveAs('ravi', a); // final: claim APPROVED
    await rejectAs('ravi', b); // claim REJECTED
    await approveAs('ravi', c); // intermediate: claim still SUBMITTED

    const decided = await page('ravi', DECIDED);
    expect(decided.data.map((t) => [t.claimId, t.status])).toEqual([
      [c.id, 'APPROVED'],
      [b.id, 'REJECTED'],
      [a.id, 'APPROVED'],
    ]); // newest decision first
    for (const t of decided.data) expect(t.decidedAt).not.toBeNull();
    const times = decided.data.map((t) => Date.parse(t.decidedAt!));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(await queue('ravi', { status: 'APPROVED' })).toEqual([c.id, a.id]);
    expect(await queue('ravi', { status: 'REJECTED' })).toEqual([b.id]);
    expect(await queue('ravi', { status: 'REJECTED,APPROVED' })).toEqual([c.id, b.id, a.id]); // order-free
    expect(await queue('ravi')).toEqual([]); // nothing left PENDING for Ravi

    // Asha resubmits B: revision 2 is PENDING with Ravi again, and his revision-1 rejection stays
    // on the Decided tab as what it was
    await submitAs('asha', b);
    const pending = await page('ravi');
    expect(pending.data.map((t) => [t.claimId, t.revision, t.status])).toEqual([
      [b.id, 2, 'PENDING'],
    ]);
    const history = await page('ravi', { status: 'REJECTED' });
    expect(history.data.map((t) => [t.claimId, t.revision, t.status])).toEqual([
      [b.id, 1, 'REJECTED'],
    ]);
    // Meera's level-2 step of C is PENDING; she has decided nothing
    expect(await queue('meera')).toEqual([c.id]);
    expect(await queue('meera', DECIDED)).toEqual([]);
  });

  it('from/to use IST day boundaries (23:59:59.999 IST in, 00:00 next day out)', async () => {
    const instants = {
      augLast: '2026-08-31T18:29:59.999Z', // 31 Aug 23:59:59.999 IST
      sepFirst: '2026-08-31T18:30:00.000Z', // 1 Sep 00:00:00.000 IST
      sepLast: '2026-09-30T18:29:59.999Z', // 30 Sep 23:59:59.999 IST
      octFirst: '2026-09-30T18:30:00.000Z', // 1 Oct 00:00:00.000 IST
    };
    type Key = keyof typeof instants;
    // Ravi decides level 1 of four ₹25,000 claims at those instants (decided_at), which also
    // activates Meera's level 2 at the same instant (activated_at)
    const claims = {} as Record<Key, ClaimDetail>;
    for (const [key, at] of Object.entries(instants) as [Key, string][]) {
      claims[key] = await submitted(2_500_000, 'asha', key);
      await ownerDecideAt('ravi', claims[key], 'APPROVED', at);
    }
    const id = (k: Key) => claims[k].id;
    const [row] = await ownerSql<{ decided_at: Date; activated_at: Date }>`
      SELECT r.decided_at, m.activated_at
        FROM approval_steps r JOIN approval_steps m ON m.submission_id = r.submission_id AND m.level = 2
       WHERE r.claim_id = ${id('sepLast')} AND r.level = 1`;
    expect(row!.decided_at.toISOString()).toBe(instants.sepLast); // the owner's instant was kept
    expect(row!.activated_at.toISOString()).toBe(instants.sepLast);

    // Decided tab: decided_at, newest first
    const sep = { from: '2026-09-01', to: '2026-09-30' };
    expect(await queue('ravi', { ...DECIDED, ...sep })).toEqual([id('sepLast'), id('sepFirst')]);
    expect(await queue('ravi', { ...DECIDED, from: '2026-10-01' })).toEqual([id('octFirst')]);
    expect(await queue('ravi', { ...DECIDED, to: '2026-08-31' })).toEqual([id('augLast')]);
    expect(await queue('ravi', { ...DECIDED, from: '2026-09-30', to: '2026-09-30' })).toEqual([
      id('sepLast'),
    ]);
    expect(await queue('ravi', { ...DECIDED, from: '2026-09-01', to: '2026-09-01' })).toEqual([
      id('sepFirst'),
    ]);

    // Pending tab: activated_at ("routed to me between"), oldest first
    expect(await queue('meera', sep)).toEqual([id('sepFirst'), id('sepLast')]);
    expect(await queue('meera', { from: '2026-10-01' })).toEqual([id('octFirst')]);
    expect(await queue('meera', { to: '2026-08-31' })).toEqual([id('augLast')]);
    expect(await queue('meera', { from: '2026-09-30', to: '2026-09-30' })).toEqual([id('sepLast')]);
    // The filter is the tab's own column: these claims were submitted today, but routed to Meera
    // (and decided by Ravi) in August–October 1st
    const today = todayInBusinessTz();
    expect(await queue('meera', { from: today })).toEqual([]);
    expect(await queue('ravi', { ...DECIDED, from: today })).toEqual([]);
    expect(await queue('meera')).toEqual([
      id('augLast'),
      id('sepFirst'),
      id('sepLast'),
      id('octFirst'),
    ]);

    const backwards = await list('meera', { from: '2026-09-30', to: '2026-09-01' });
    expect([backwards.status, (await errorOf(backwards)).error.code]).toEqual([
      422,
      'VALIDATION_FAILED',
    ]);
    for (const bad of ['2026-02-30', '30/09/2026', '2026-9-1']) {
      const res = await list('meera', { from: bad });
      expect([bad, res.status]).toEqual([bad, 422]);
    }
  });

  it('keyset pages are complete and disjoint including ties on activated_at', async () => {
    // 7 claims, Ravi's level-1 decisions on 3 instants: Meera's level-2 steps tie on activated_at
    // and Ravi's decided steps tie on decided_at, so most page boundaries fall inside a tie
    const ats = [
      ...Array<string>(3).fill('2026-10-05T04:30:00.000Z'),
      '2026-10-06T04:30:00.000Z',
      ...Array<string>(3).fill('2026-10-07T04:30:00.000Z'),
    ];
    for (const at of ats) await ownerDecideAt('ravi', await submitted(2_500_000), 'APPROVED', at);
    const arjuns = await submitted(2_500_000, 'arjun'); // [neha, meera]: Neha decides, Meera ties
    await ownerDecideAt('neha', arjuns, 'APPROVED', '2026-10-05T04:30:00.000Z');

    /** Pages through with `limit`, returning claim ids in order and the page count. */
    async function drain(as: Persona, query: Record<string, string>, limit: number) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const p: ApprovalTaskPage = await page(as, {
          ...query,
          limit: String(limit),
          ...(cursor ? { cursor } : {}),
        });
        expect(p.page.limit).toBe(limit);
        expect(p.data.length).toBeLessThanOrEqual(limit);
        seen.push(...p.data.map((t) => t.stepId));
        cursor = p.page.nextCursor;
        if (pages === 0 && as === 'meera' && !query.status)
          await approveAs('ravi', await submitted(2_500_000)); // routed mid-paging: activated now, so last
        pages++;
      } while (cursor && pages < 20);
      return { seen, pages };
    }

    // Pending (Meera): 8 tied/backdated steps + 1 routed mid-paging, oldest first
    const pending = await drain('meera', {}, 2);
    const meera = await asPersona('meera');
    const expectedPending = (
      await ownerSql<{ id: string }>`
        SELECT id FROM approval_steps WHERE approver_id = ${meera.id} AND status = 'PENDING'
         ORDER BY activated_at ASC, id ASC`
    ).map((r) => r.id);
    expect(expectedPending).toHaveLength(9);
    expect(pending.seen).toEqual(expectedPending); // complete, disjoint and in order
    expect(new Set(pending.seen).size).toBe(pending.seen.length);
    expect(pending.pages).toBe(5); // 2+2+2+2+1, and the last page says there is no next one

    // Decided (Ravi): 7 tied steps + 1 real decision (the mid-paging one), newest first
    const decided = await drain('ravi', DECIDED, 3);
    const ravi = await asPersona('ravi');
    const expectedDecided = (
      await ownerSql<{ id: string }>`
        SELECT id FROM approval_steps
         WHERE approver_id = ${ravi.id} AND status IN ('APPROVED', 'REJECTED')
         ORDER BY decided_at DESC, id DESC`
    ).map((r) => r.id);
    expect(expectedDecided).toHaveLength(8);
    expect(decided.seen).toEqual(expectedDecided);
    expect(decided.pages).toBe(3); // 3+3+2

    // A cursor is bound to its tab and filters (not to limit), and can't be forged
    const first = await page('meera', { limit: '2' });
    const next = first.page.nextCursor!;
    expect((await list('meera', { cursor: next, limit: '5' })).status).toBe(200);
    const stale: Record<string, string>[] = [
      { cursor: next, ...DECIDED }, // a Pending cursor on the Decided tab
      { cursor: next, from: '2026-10-01' }, // different filters
      { cursor: 'bm9wZQ' }, // garbage
      { cursor: Buffer.from(JSON.stringify({ id: randomUUID() })).toString('base64url') },
    ];
    for (const query of stale) {
      const res = await list('meera', query);
      expect([res.status, (await errorOf(res)).error.code]).toEqual([422, 'INVALID_CURSOR']);
    }
    // a cursor carries a position, not a permission: replayed by Neha it only moves HER window
    const nehas = await submitted(500_000, 'arjun'); // [neha], routed now: after the position
    expect(await queue('neha', { cursor: next })).toEqual([nehas.id]);
  });

  it('a non-approver gets 403 FORBIDDEN', async () => {
    const c = await submitted(800_000); // something exists to be listed
    for (const as of ['asha', 'arjun', 'admin', 'farah'] as const) {
      // farah is FINANCE; the others have no can_approve
      const variants: Record<string, string>[] = [{}, DECIDED, { sort: 'activatedAt:desc' }];
      for (const query of variants) {
        const res = await list(as, query);
        const { error } = await errorOf(res);
        expect([as, query, res.status, error.code]).toEqual([as, query, 403, 'FORBIDDEN']); // the gate runs before validation
        expect(JSON.stringify(error)).not.toContain(c.claimNumber);
      }
    }
    // the service guards itself as well: FORBIDDEN before a single statement
    const queries = captureQueries();
    await expect(
      approvalsService.listQueue(ctx(await asPersona('farah')), { status: ['PENDING'], limit: 25 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(queries).toEqual([]);
    expect(await queue('ravi')).toEqual([c.id]); // positive control
  });
});
