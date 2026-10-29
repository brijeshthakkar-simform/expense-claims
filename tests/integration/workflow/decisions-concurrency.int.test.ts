// TC-I20 (RT-m11): decision races (07 §10, 02 §8). Ten identical approvals arrive at once; the
// PENDING-scoped claim lock serialises them, the first one wins, and every loser re-reads under the
// lock, finds no PENDING step of its own and gets 409 ALREADY_DECIDED (never a silent 200, never a
// 500, never a second event). P5 adds "approve racing recall", with gate() forcing each order.
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route';
import { asPersona, type Persona } from '../../helpers/auth';
import { gate, ownerSql, waitForLockWaiters } from '../../helpers/db';
import { makeDraft, submitAs, type ClaimDetail } from '../../helpers/factories';
import { callRoute } from '../../helpers/http';

/** Fires `n` approvals by `as` at once; returns 'OK' or the error code of each. */
async function race(as: Persona, claimId: string, n = 10): Promise<string[]> {
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      callRoute(approveRoute, 'POST', {
        path: `/api/v1/claims/${claimId}/approve`,
        params: { claimId },
        body: { revision: 1 },
        as,
      }),
    ),
  );
  return Promise.all(
    results.map(async (r) =>
      r.status === 200
        ? 'OK'
        : `${r.status} ${((await r.json()) as { error: { code: string } }).error.code}`,
    ),
  );
}
const decisionEvents = (claimId: string) =>
  ownerSql<{ type: string }>`
    SELECT type::text FROM claim_events WHERE claim_id = ${claimId} AND type <> 'CLAIM_SUBMITTED'`;
const stepStatuses = async (claimId: string) =>
  (
    await ownerSql<{ status: string }>`
      SELECT status::text FROM approval_steps WHERE claim_id = ${claimId} ORDER BY level`
  ).map((s) => s.status);

describe('TC-I20 decision races', () => {
  it('10 parallel approvals of one step produce exactly 1 success and 1 event', async () => {
    // The final (only) level: one CLAIM_APPROVED
    const c = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] }),
    ); // 1 step: ravi
    const codes = await race('ravi', c.id);
    expect(codes.filter((x) => x === 'OK')).toHaveLength(1);
    expect(new Set(codes.filter((x) => x !== 'OK'))).toEqual(new Set(['409 ALREADY_DECIDED'])); // never a silent 200
    expect(await decisionEvents(c.id)).toEqual([{ type: 'CLAIM_APPROVED' }]);
    expect(await ownerSql`SELECT status::text FROM claims WHERE id = ${c.id}`).toEqual([
      { status: 'APPROVED' },
    ]);

    // An intermediate level: one STEP_APPROVED, and level 2 activated exactly once
    const two = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
    ); // [ravi, meera]
    const twoCodes = await race('ravi', two.id);
    expect(twoCodes.filter((x) => x === 'OK')).toHaveLength(1);
    expect(new Set(twoCodes.filter((x) => x !== 'OK'))).toEqual(new Set(['409 ALREADY_DECIDED']));
    expect(await decisionEvents(two.id)).toEqual([{ type: 'STEP_APPROVED' }]);
    expect(await stepStatuses(two.id)).toEqual(['APPROVED', 'PENDING']);
    expect(await ownerSql`SELECT status::text FROM claims WHERE id = ${two.id}`).toEqual([
      { status: 'SUBMITTED' },
    ]);
  });

  it('approve racing recall: on the final level exactly one wins; on an intermediate level both succeed in lock order; status, steps and events agree', async () => {
    const ravi = await asPersona('ravi');
    const meera = await asPersona('meera');

    // Final level (1 step: ravi). Approve first → APPROVED, and the recall then finds a locked claim
    const a = await claimOf(800_000);
    expect(await raceInOrder(a, ['approve', 'recall'])).toEqual({
      approve: 'OK',
      recall: '409 CLAIM_LOCKED',
    });
    expect(await stateOf(a.id)).toEqual({
      status: 'APPROVED',
      steps: ['APPROVED'],
      events: ['CLAIM_SUBMITTED', 'CLAIM_APPROVED'],
    });

    // Final level, recall first → DRAFT with the step CANCELLED; the approver's queue is empty
    const b = await claimOf(800_000);
    expect(await raceInOrder(b, ['recall', 'approve'])).toEqual({
      recall: 'OK',
      approve: '403 NOT_IN_YOUR_QUEUE',
    });
    expect(await stateOf(b.id)).toEqual({
      status: 'DRAFT',
      steps: ['CANCELLED'],
      events: ['CLAIM_SUBMITTED', 'CLAIM_RECALLED'],
    });
    expect(await recalledPayload(b.id)).toEqual({
      cancelledSteps: [
        { stepId: expect.any(String), level: 1, approverId: ravi.id, wasStatus: 'PENDING' },
      ],
      approvedLevelsVoided: 0,
    });

    // Intermediate level ([ravi, meera]). Approve first → both succeed in lock order: L1 stays
    // APPROVED and the level the approval just activated is cancelled by the recall
    const c = await claimOf(2_500_000);
    expect(await raceInOrder(c, ['approve', 'recall'])).toEqual({ approve: 'OK', recall: 'OK' });
    expect(await stateOf(c.id)).toEqual({
      status: 'DRAFT',
      steps: ['APPROVED', 'CANCELLED'],
      events: ['CLAIM_SUBMITTED', 'STEP_APPROVED', 'CLAIM_RECALLED'],
    });
    expect(await recalledPayload(c.id)).toEqual({
      cancelledSteps: [
        { stepId: expect.any(String), level: 2, approverId: meera.id, wasStatus: 'PENDING' },
      ],
      approvedLevelsVoided: 1,
    });

    // Intermediate level, recall first → the recall wins whole; the approver gets the uniform 403
    const d = await claimOf(2_500_000);
    expect(await raceInOrder(d, ['recall', 'approve'])).toEqual({
      recall: 'OK',
      approve: '403 NOT_IN_YOUR_QUEUE',
    });
    expect(await stateOf(d.id)).toEqual({
      status: 'DRAFT',
      steps: ['CANCELLED', 'CANCELLED'],
      events: ['CLAIM_SUBMITTED', 'CLAIM_RECALLED'],
    });
    expect(await recalledPayload(d.id)).toEqual({
      cancelledSteps: [
        { stepId: expect.any(String), level: 1, approverId: ravi.id, wasStatus: 'PENDING' },
        { stepId: expect.any(String), level: 2, approverId: meera.id, wasStatus: 'WAITING' },
      ],
      approvedLevelsVoided: 0,
    });
  });
});

/** A fresh SUBMITTED claim of Asha's: ₹8,000 → [ravi]; ₹25,000 → [ravi, meera]. */
async function claimOf(amountMinor: number): Promise<ClaimDetail> {
  return submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor }] }));
}

type Contender = 'approve' | 'recall';

/**
 * Forces the order (07 §10): a third connection holds the claim row lock (gate), each request is
 * sent only once the previous one is queued behind it, then the gate opens. Returns 'OK' or
 * '<status> <code>' per contender.
 */
async function raceInOrder(
  c: ClaimDetail,
  order: [Contender, Contender],
): Promise<Record<Contender, string>> {
  const send: Record<Contender, () => Promise<Response>> = {
    approve: () =>
      callRoute(approveRoute, 'POST', {
        path: `/api/v1/claims/${c.id}/approve`,
        params: { claimId: c.id },
        body: { revision: c.currentRevision },
        as: 'ravi',
      }),
    recall: () =>
      callRoute(recallRoute, 'POST', {
        path: `/api/v1/claims/${c.id}/recall`,
        params: { claimId: c.id },
        as: 'asha',
      }),
  };
  const g = await gate(c.id);
  const pending: Promise<Response>[] = [];
  try {
    for (const [i, who] of order.entries()) {
      pending.push(send[who]());
      await waitForLockWaiters(i + 1); // queued behind the gate (and the earlier contender)
    }
  } finally {
    await g.release();
  }
  const [first, second] = await Promise.all(pending);
  const label = async (r: Response) =>
    r.status === 200
      ? 'OK'
      : `${r.status} ${((await r.json()) as { error: { code: string } }).error.code}`;
  return { [order[0]]: await label(first!), [order[1]]: await label(second!) } as Record<
    Contender,
    string
  >;
}

/** Claim status, step statuses (level order) and event types (oldest first) must tell one story. */
async function stateOf(claimId: string) {
  const [claim] = await ownerSql<{ status: string }>`
    SELECT status::text FROM claims WHERE id = ${claimId}`;
  return {
    status: claim!.status,
    steps: await stepStatuses(claimId),
    events: (
      await ownerSql<{ type: string }>`
        SELECT type::text FROM claim_events WHERE claim_id = ${claimId} ORDER BY occurred_at, id`
    ).map((e) => e.type),
  };
}

const recalledPayload = async (claimId: string) =>
  (
    await ownerSql<{ payload: unknown }>`
      SELECT payload FROM claim_events WHERE claim_id = ${claimId} AND type = 'CLAIM_RECALLED'`
  )[0]?.payload;
