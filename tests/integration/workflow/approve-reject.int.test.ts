// TC-I19 (§6-2, §2-Approver, §3.5-c, RT-M8, RT-M9): approve and reject through the real route
// handlers, the C-25 write orders and the 04 §6 ladder: 403 FORBIDDEN (role gate) → 403
// NOT_IN_YOUR_QUEUE (no PENDING step for me, uniform for every id) → 409 ALREADY_DECIDED /
// REVISION_MISMATCH → 422 VALIDATION_FAILED. Every refusal leaves the claim untouched, and the DB
// re-checks eligibility (UC008) even when the service check is bypassed.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as rejectRoute from '@/app/api/v1/claims/[claimId]/reject/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as approvalsService from '@/server/services/approvals.service';
import type { ClaimDetail } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { appClient, captureQueries, ownerSql, rejects } from '../../helpers/db';
import { approveAs, ctx, makeDraft, rejectAs, submitAs } from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';
import { rawDecide } from '../../helpers/raw-submit';

const approve = (as: Persona, id: string, body: unknown = { revision: 1 }) =>
  callRoute(approveRoute, 'POST', {
    path: `/api/v1/claims/${id}/approve`,
    params: { claimId: id },
    body,
    as,
  });
const reject = (
  as: Persona,
  id: string,
  body: unknown = { revision: 1, reason: 'Hotel invoice missing for 3 Oct' },
) =>
  callRoute(rejectRoute, 'POST', {
    path: `/api/v1/claims/${id}/reject`,
    params: { claimId: id },
    body,
    as,
  });
const outcome = async (r: Response) => [r.status, (await errorOf(r)).error.code];
const detailOf = async (r: Response) => ((await r.json()) as { data: ClaimDetail }).data;

/** A fresh SUBMITTED claim of Asha's for `amountMinor` (₹8,000 → [ravi]; ₹25,000 → [ravi, meera]). */
const submitted = async (amountMinor: number, title?: string) =>
  submitAs('asha', await makeDraft('asha', { title, lines: [{ amountMinor }] }));

/** Status, revision, step statuses and event count: what a refused decision must not change. */
const footprint = async (claimId: string) =>
  (
    await ownerSql`
      SELECT c.status::text, c.current_revision, c.approved_at, c.rejected_at,
             (SELECT json_agg(s.status::text ORDER BY s.level)
                FROM approval_steps s WHERE s.submission_id = c.current_submission_id) AS steps,
             (SELECT count(*)::int FROM claim_events e WHERE e.claim_id = c.id) AS events
        FROM claims c WHERE c.id = ${claimId}`
  )[0];
const decisionEvents = (claimId: string) =>
  ownerSql<{ type: string; actor: string }>`
    SELECT e.type::text, split_part(u.email, '.', 1) AS actor
      FROM claim_events e JOIN users u ON u.id = e.actor_id
     WHERE e.claim_id = ${claimId} AND e.type NOT IN ('CLAIM_SUBMITTED', 'CLAIM_RESUBMITTED')
     ORDER BY e.occurred_at, e.id`;

describe('TC-I19 approve and reject', () => {
  it('approving a claim that is not in my queue returns 403 NOT_IN_YOUR_QUEUE', async () => {
    const c02 = await submitted(800_000); // PENDING with Ravi; Neha is outside Asha's chain
    const before = await footprint(c02.id);
    expect(await outcome(await approve('neha', c02.id))).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    expect(await outcome(await reject('neha', c02.id))).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    expect(await footprint(c02.id)).toEqual(before);

    // positive control: Neha CAN decide what is routed to her (Arjun ₹5,000 → [neha])
    const c08 = await submitAs(
      'arjun',
      await makeDraft('arjun', { lines: [{ amountMinor: 500_000 }] }),
    );
    const res = await approve('neha', c08.id);
    expect(res.status).toBe(200);
    expect((await detailOf(res)).status).toBe('APPROVED');
  });

  it('approving a non-existent id returns the same 403 NOT_IN_YOUR_QUEUE body', async () => {
    const c02 = await submitted(800_000);
    const strip = async (r: Response) => {
      const b = (await r.json()) as { error: Record<string, unknown> };
      expect(b.error.requestId).toBe(r.headers.get('x-request-id'));
      delete b.error.requestId;
      return { status: r.status, error: b.error };
    };
    const random = randomUUID();
    const [real, missing] = await Promise.all([
      approve('neha', c02.id).then(strip),
      approve('neha', random).then(strip),
    ]);
    expect(real).toEqual(missing); // no existence oracle: only requestId differs
    expect(real).toMatchObject({ status: 403, error: { code: 'NOT_IN_YOUR_QUEUE' } });
    expect(JSON.stringify(real)).not.toContain(c02.claimNumber);
    // the same for reject, and for an id that is not even a UUID (404 from the params schema)
    expect(await reject('neha', c02.id).then(strip)).toEqual(
      await reject('neha', random).then(strip),
    );
    expect(await outcome(await approve('neha', 'not-a-uuid'))).toEqual([404, 'CLAIM_NOT_FOUND']);
  });

  it('the L2 approver while WAITING gets 403 NOT_IN_YOUR_QUEUE', async () => {
    const c = await submitted(2_500_000); // [ravi PENDING, meera WAITING]
    const before = await footprint(c.id);
    expect(before?.steps).toEqual(['PENDING', 'WAITING']);
    expect(await outcome(await approve('meera', c.id))).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    expect(await outcome(await reject('meera', c.id))).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    expect(await footprint(c.id)).toEqual(before);

    // once Ravi approves, the very same request succeeds
    await approveAs('ravi', c);
    expect((await approve('meera', c.id)).status).toBe(200);
  });

  it('double approve returns 200 then 409 ALREADY_DECIDED with exactly one event', async () => {
    const c = await submitted(800_000);
    const first = await approve('ravi', c.id);
    expect(first.status).toBe(200);
    expect(await detailOf(first)).toMatchObject({ status: 'APPROVED', allowedActions: [] });
    const after = await footprint(c.id);

    expect(await outcome(await approve('ravi', c.id))).toEqual([409, 'ALREADY_DECIDED']);
    expect(await outcome(await reject('ravi', c.id))).toEqual([409, 'ALREADY_DECIDED']);
    expect(await decisionEvents(c.id)).toEqual([{ type: 'CLAIM_APPROVED', actor: 'ravi' }]);
    expect(await footprint(c.id)).toEqual(after);

    // an intermediate level too: Ravi's second approve on a 2-step claim is ALREADY_DECIDED, not
    // NOT_IN_YOUR_QUEUE (he decided the current revision and can still read it)
    const two = await submitted(2_500_000);
    expect((await approve('ravi', two.id)).status).toBe(200);
    expect(await outcome(await approve('ravi', two.id))).toEqual([409, 'ALREADY_DECIDED']);
    expect(await decisionEvents(two.id)).toEqual([{ type: 'STEP_APPROVED', actor: 'ravi' }]);
  });

  it('stale revision returns 409 REVISION_MISMATCH', async () => {
    // Revision 1 is rejected, Asha resubmits as revision 2: Ravi is PENDING again, but a request
    // made from the revision-1 page must not approve content he didn't see
    const c = await submitted(800_000);
    await rejectAs('ravi', c);
    const r2 = await submitAs('asha', c);
    expect(r2).toMatchObject({ status: 'SUBMITTED', currentRevision: 2 });
    const before = await footprint(c.id);

    const attempts: [number, Response][] = [
      [1, await approve('ravi', c.id, { revision: 1 })],
      [1, await reject('ravi', c.id, { revision: 1, reason: 'Hotel invoice missing for 3 Oct' })],
      [3, await approve('ravi', c.id, { revision: 3 })], // a revision from the future is no better
    ];
    for (const [requestedRevision, res] of attempts) {
      const { error } = await errorOf(res);
      expect([res.status, error.code]).toEqual([409, 'REVISION_MISMATCH']);
      expect(error.details).toEqual({ requestedRevision, currentRevision: 2 });
    }
    expect(await footprint(c.id)).toEqual(before);
    // the current revision goes through
    expect((await approve('ravi', c.id, { revision: 2 })).status).toBe(200);
  });

  it('reject without a reason or with < 10 characters returns 422 VALIDATION_FAILED', async () => {
    const c = await submitted(800_000);
    const before = await footprint(c.id);
    const bodies: unknown[] = [
      { revision: 1 }, // missing
      { revision: 1, reason: '' },
      { revision: 1, reason: 'No' },
      { revision: 1, reason: '123456789' }, // 9
      { revision: 1, reason: '   short    ' }, // trimmed to 5
      { revision: 1, reason: 'x'.repeat(1001) },
      { revision: 1, reason: 42 },
    ];
    for (const body of bodies) {
      const res = await reject('ravi', c.id, body);
      const { error } = await errorOf(res);
      expect([body, res.status, error.code]).toEqual([body, 422, 'VALIDATION_FAILED']);
      expect(error.details?.issues).toEqual([expect.objectContaining({ path: ['reason'] })]);
    }
    expect(await footprint(c.id)).toEqual(before);

    // boundary: exactly 10 characters after trimming is accepted, and stored trimmed
    const ok = await reject('ravi', c.id, { revision: 1, reason: '  1234567890  ' });
    expect(ok.status).toBe(200);
    expect(
      await ownerSql`SELECT rejection_reason FROM approval_steps WHERE claim_id = ${c.id}`,
    ).toEqual([{ rejection_reason: '1234567890' }]);
  });

  it('FINANCE approve/reject returns 403 FORBIDDEN', async () => {
    const c = await submitted(800_000);
    const before = await footprint(c.id);
    for (const as of ['farah', 'asha', 'arjun', 'admin'] as const) {
      // farah is FINANCE; the others have no can_approve
      expect([as, ...(await outcome(await approve(as, c.id)))]).toEqual([as, 403, 'FORBIDDEN']);
      expect([as, ...(await outcome(await reject(as, c.id)))]).toEqual([as, 403, 'FORBIDDEN']);
    }
    // a random id gets the same FORBIDDEN: the role gate runs before any query
    expect(await outcome(await approve('farah', randomUUID()))).toEqual([403, 'FORBIDDEN']);
    expect(await footprint(c.id)).toEqual(before);

    // The service guards itself too (D-04): FORBIDDEN without sending a single statement
    const farah = await asPersona('farah');
    const queries = captureQueries();
    await expect(approvalsService.approve(ctx(farah), c.id, { revision: 1 })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    await expect(
      approvalsService.reject(ctx(farah), c.id, { revision: 1, reason: 'Hotel invoice missing' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(queries).toEqual([]);
  });

  it('an approver demoted to FINANCE mid-chain is refused by the DB (UC008) even if the service check is bypassed', async () => {
    const c = await submitted(2_500_000); // [ravi PENDING, meera WAITING]
    const staleRavi = await asPersona('ravi'); // loaded while he could still approve
    await ownerSql`UPDATE users SET role = 'FINANCE', can_approve = false
                    WHERE email = 'ravi.menon@acme.test'`;
    const before = await footprint(c.id);

    // Over HTTP the actor is re-read from the session on every request: the gate refuses him
    expect(await outcome(await approve('ravi', c.id))).toEqual([403, 'FORBIDDEN']);
    // The service with a stale actor passes its own gate, so the trigger is the last line
    await rejects('UC008', () => approvalsService.approve(ctx(staleRavi), c.id, { revision: 1 }));
    await rejects('UC008', () =>
      approvalsService.reject(ctx(staleRavi), c.id, {
        revision: 1,
        reason: 'Hotel invoice missing for 3 Oct',
      }),
    );
    // ... and so does raw SQL as expense_app in the C-25 order
    await rejects('UC008', async () =>
      rawDecide(await appClient(), c.id, { approverId: staleRavi.id, outcome: 'APPROVED' }),
    );
    expect(await footprint(c.id)).toEqual(before);

    // Positive control: restored, the same raw transaction commits
    await ownerSql`UPDATE users SET role = 'EMPLOYEE', can_approve = true
                    WHERE email = 'ravi.menon@acme.test'`;
    await rawDecide(await appClient(), c.id, { approverId: staleRavi.id, outcome: 'APPROVED' });
    expect((await footprint(c.id))?.steps).toEqual(['APPROVED', 'PENDING']);
  });

  it('intermediate approval keeps SUBMITTED and activates the next level; final approval sets APPROVED and approved_at', async () => {
    const c = await submitted(2_500_000, 'Client workshop, Pune');
    const first = await approve('ravi', c.id, { revision: 1, comment: '  Looks fine  ' });
    expect(first.status).toBe(200);
    const mid = await detailOf(first);
    expect(mid).toMatchObject({ status: 'SUBMITTED', approvedAt: null, currentRevision: 1 });
    expect(mid.allowedActions).toEqual([]); // Ravi has decided: read-only
    expect(mid.approval?.steps).toMatchObject([
      { level: 1, status: 'APPROVED', comment: 'Looks fine', approver: { name: 'Ravi Menon' } },
      { level: 2, status: 'PENDING', decidedAt: null, approver: { name: 'Meera Iyer' } },
    ]);
    const [s1, s2] = mid.approval!.steps;
    expect(s1!.decidedAt).not.toBeNull();
    expect(s2!.activatedAt).not.toBeNull();
    expect(Date.parse(s2!.activatedAt!)).toBeGreaterThanOrEqual(Date.parse(s1!.decidedAt!));

    // Meera now sees it with the decision actions
    const meera = await approvalsService
      .listQueue(ctx(await asPersona('meera')), { status: ['PENDING'], limit: 25 })
      .then((p) => p.items.map((t) => t.claimId));
    expect(meera).toEqual([c.id]);

    const final = await approve('meera', c.id);
    expect(final.status).toBe(200);
    const done = await detailOf(final);
    expect(done).toMatchObject({ status: 'APPROVED', allowedActions: [] });
    expect(done.approvedAt).not.toBeNull();
    expect(done.approval?.steps.map((s) => s.status)).toEqual(['APPROVED', 'APPROVED']);
    const [row] = await ownerSql<{ approved_at: Date; decided_at: Date }>`
      SELECT c.approved_at, s.decided_at FROM claims c
        JOIN approval_steps s ON s.claim_id = c.id AND s.level = 2 WHERE c.id = ${c.id}`;
    expect(row!.approved_at.toISOString()).toBe(row!.decided_at.toISOString()); // one instant
    expect(await decisionEvents(c.id)).toEqual([
      { type: 'STEP_APPROVED', actor: 'ravi' },
      { type: 'CLAIM_APPROVED', actor: 'meera' },
    ]);
  });

  it('rejection cancels WAITING steps and sets REJECTED with the reason', async () => {
    const c = await submitted(7_500_000); // [ravi, meera, vikram]
    await approveAs('ravi', c);
    const res = await reject('meera', c.id, {
      revision: 1,
      reason: '  Venue quote is not itemised  ',
    });
    expect(res.status).toBe(200);
    const d = await detailOf(res);
    expect(d).toMatchObject({ status: 'REJECTED', approvedAt: null, allowedActions: [] });
    expect(d.rejectedAt).not.toBeNull();
    expect(d.approval?.steps).toMatchObject([
      { level: 1, status: 'APPROVED' },
      { level: 2, status: 'REJECTED', rejectionReason: 'Venue quote is not itemised' },
      { level: 3, status: 'CANCELLED', decidedAt: null },
    ]);
    const steps = await ownerSql<{ level: number; status: string; cancelled_at: Date | null }>`
      SELECT level, status::text, cancelled_at FROM approval_steps WHERE claim_id = ${c.id} ORDER BY level`;
    expect(steps[2]!.cancelled_at).not.toBeNull();
    expect(steps.slice(0, 2).map((s) => s.cancelled_at)).toEqual([null, null]);

    const [event] = await ownerSql<{ reason: string; payload: { cancelledStepIds: string[] } }>`
      SELECT reason, payload FROM claim_events WHERE claim_id = ${c.id} AND type = 'CLAIM_REJECTED'`;
    expect(event?.reason).toBe('Venue quote is not itemised');
    const [vikramStep] = await ownerSql<{ id: string }>`
      SELECT id FROM approval_steps WHERE claim_id = ${c.id} AND level = 3`;
    expect(event?.payload.cancelledStepIds).toEqual([vikramStep!.id]);

    // the claim is the claimant's to edit again; nobody can decide it any more
    const asha = await callRoute(claimRoute, 'GET', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
    });
    expect((await detailOf(asha)).allowedActions).toEqual(['EDIT', 'SUBMIT']);
    expect(await outcome(await approve('vikram', c.id))).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    expect(await outcome(await approve('meera', c.id))).toEqual([409, 'ALREADY_DECIDED']);
  });
});
