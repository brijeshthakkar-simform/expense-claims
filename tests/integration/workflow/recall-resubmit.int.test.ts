// TC-I21 (§3.2-d, §7-Q1, RT-m1): the amount-change rule and recall (02 §6). While SUBMITTED
// nothing on a claim can change; to change it the claimant recalls it (legal until the final
// approval, including after intermediate approvals), and the next submit builds a brand-new chain
// from the new total. Earlier approvals stay in history against their revision and never carry
// over. A cancelled approver loses read access, because CANCELLED grants no visibility.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as historyRoute from '@/app/api/v1/claims/[claimId]/history/route';
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import { ClaimEventInputSchema } from '@/server/audit/events';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ClaimHistory } from '@/shared/dto/history';
import { asPersona, type Persona } from '../../helpers/auth';
import { appSql, ownerSql, rejects } from '../../helpers/db';
import {
  approveAs,
  lineInput,
  makeDraft,
  recallAs,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const recall = (as: Persona, id: string, body?: unknown) =>
  callRoute(recallRoute, 'POST', {
    path: `/api/v1/claims/${id}/recall`,
    params: { claimId: id },
    body,
    as,
  });
const put = (as: Persona, id: string, body: unknown) =>
  callRoute(claimRoute, 'PUT', { path: `/api/v1/claims/${id}`, params: { claimId: id }, body, as });
const get = (as: Persona, id: string) =>
  callRoute(claimRoute, 'GET', { path: `/api/v1/claims/${id}`, params: { claimId: id }, as });
const history = (as: Persona, id: string) =>
  callRoute(historyRoute, 'GET', {
    path: `/api/v1/claims/${id}/history`,
    params: { claimId: id },
    as,
  });
const outcome = async (r: Response): Promise<[number, string]> => [
  r.status,
  r.status === 200 ? 'OK' : (await errorOf(r)).error.code,
];

/** Steps of every revision, as the DB holds them: "r<rev>:L<level>:<approver>:<status>". */
const allSteps = async (claimId: string) =>
  (
    await ownerSql<{ s: string }>`
      SELECT 'r' || sub.revision || ':L' || st.level || ':' || split_part(u.email, '.', 1)
             || ':' || st.status AS s
        FROM approval_steps st
        JOIN claim_submissions sub ON sub.id = st.submission_id
        JOIN users u ON u.id = st.approver_id
       WHERE st.claim_id = ${claimId}
       ORDER BY sub.revision, st.level`
  ).map((r) => r.s);
const eventTypes = async (claimId: string) =>
  (
    await ownerSql<{ t: string }>`
      SELECT type || '(r' || revision || ')' AS t FROM claim_events
       WHERE claim_id = ${claimId} ORDER BY occurred_at, id`
  ).map((r) => r.t);
const claimRow = async (claimId: string) =>
  (
    await ownerSql<{
      status: string;
      current_revision: number;
      current_submission_id: string;
      total_minor: number;
    }>`SELECT status::text, current_revision, current_submission_id, total_minor
         FROM claims WHERE id = ${claimId}`
  )[0]!;

describe('TC-I21 recall and resubmit', () => {
  it('line items cannot be edited while SUBMITTED (409 CLAIM_NOT_EDITABLE)', async () => {
    const c = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 900_000 }, { amountMinor: 100_000 }] }),
    );
    const lines = () =>
      ownerSql`SELECT id, amount_minor, description, updated_at FROM line_items
                WHERE claim_id = ${c.id} ORDER BY id`;
    const before = await lines();

    // The spec's example: an amount edit before the first approval (₹9,000 → ₹45,000)
    const res = await put('asha', c.id, {
      title: c.title,
      lineItems: c.lineItems.map((l, i) => ({
        ...lineInput(l),
        amountMinor: i === 0 ? 4_400_000 : l.amountMinor,
      })),
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toMatchObject({
      code: 'CLAIM_NOT_EDITABLE',
      details: { hint: 'RECALL_TO_EDIT' },
    });
    // Removing a line is an edit too
    expect(
      await outcome(
        await put('asha', c.id, { title: c.title, lineItems: [lineInput(c.lineItems[0]!)] }),
      ),
    ).toEqual([409, 'CLAIM_NOT_EDITABLE']);
    // The DB backstop, if the service check were bypassed: UC002 (frozen while SUBMITTED)
    await rejects(
      'UC002',
      () => appSql`UPDATE line_items SET amount_minor = 4400000 WHERE id = ${c.lineItems[0]!.id}`,
    );
    await rejects('UC002', () => appSql`DELETE FROM line_items WHERE claim_id = ${c.id}`);
    await rejects('UC002', () => appSql`UPDATE claims SET title = 'Renamed' WHERE id = ${c.id}`);

    expect(await lines()).toEqual(before);
    expect(await claimRow(c.id)).toMatchObject({ status: 'SUBMITTED', total_minor: 1_000_000 });
    expect(await allSteps(c.id)).toEqual(['r1:L1:ravi:PENDING']); // the approver's view never moved
  });

  it('recall after L1 approved: L1 stays APPROVED on revision 1, open steps CANCELLED, claim DRAFT, CLAIM_RECALLED event', async () => {
    const asha = await asPersona('asha');
    const meera = await asPersona('meera');
    const vikram = await asPersona('vikram');
    const c = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] })),
    ); // [ravi APPROVED, meera PENDING, vikram WAITING]
    const { current_submission_id: rev1 } = await claimRow(c.id);
    const stepIds = await ownerSql<{ id: string; level: number }>`
      SELECT id, level FROM approval_steps WHERE claim_id = ${c.id} ORDER BY level`;
    const [ravisStep] = await ownerSql`
      SELECT row_to_json(s)::text AS s FROM approval_steps s WHERE claim_id = ${c.id} AND level = 1`;

    const res = await recall('asha', c.id, { note: '  Adding the venue invoice first  ' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: ClaimDetail };

    // The claim: DRAFT, revision and submission pointer unchanged, editable but not deletable
    expect(data).toMatchObject({
      status: 'DRAFT',
      currentRevision: 1,
      totalMinor: 7_500_000,
      allowedActions: ['EDIT', 'SUBMIT'],
    });
    expect(await claimRow(c.id)).toEqual({
      status: 'DRAFT',
      current_revision: 1,
      current_submission_id: rev1,
      total_minor: 7_500_000,
    });
    // The chain: L1 stays APPROVED against revision 1 (byte-identical); the open steps CANCELLED
    expect(data.approval).toMatchObject({ revision: 1 });
    expect(data.approval!.steps.map((s) => `${s.approver.name}:${s.status}`)).toEqual([
      'Ravi Menon:APPROVED',
      'Meera Iyer:CANCELLED',
      'Vikram Shah:CANCELLED',
    ]);
    expect(
      await ownerSql`
        SELECT row_to_json(s)::text AS s FROM approval_steps s WHERE claim_id = ${c.id} AND level = 1`,
    ).toEqual([ravisStep]);
    expect(
      await ownerSql`
        SELECT level, status::text, cancelled_at IS NOT NULL AS cancelled, decided_at IS NULL AS undecided
          FROM approval_steps WHERE claim_id = ${c.id} AND level > 1 ORDER BY level`,
    ).toEqual([
      { level: 2, status: 'CANCELLED', cancelled: true, undecided: true },
      { level: 3, status: 'CANCELLED', cancelled: true, undecided: true },
    ]);

    // The event: exactly one typed CLAIM_RECALLED, by the claimant, carrying the cascade
    const events = await ownerSql<{
      type: string;
      submission_id: string;
      step_id: string | null;
      revision: number;
      total_minor: number;
      reason: string | null;
      payload: Record<string, unknown>;
      actor_id: string;
      actor_role: string;
      from_status: string;
      to_status: string;
      request_id: string;
    }>`SELECT * FROM claim_events WHERE claim_id = ${c.id} ORDER BY occurred_at, id`;
    expect(events.map((e) => e.type)).toEqual([
      'CLAIM_SUBMITTED',
      'STEP_APPROVED',
      'CLAIM_RECALLED',
    ]);
    const e = events[2]!;
    expect(
      ClaimEventInputSchema.parse({
        type: e.type,
        claimId: c.id,
        submissionId: e.submission_id,
        revision: e.revision,
        totalMinor: e.total_minor,
        reason: e.reason,
        payload: e.payload,
      }),
    ).toEqual({
      type: 'CLAIM_RECALLED',
      claimId: c.id,
      submissionId: rev1,
      revision: 1,
      totalMinor: 7_500_000,
      reason: 'Adding the venue invoice first', // trimmed
      payload: {
        cancelledSteps: [
          { stepId: stepIds[1]!.id, level: 2, approverId: meera.id, wasStatus: 'PENDING' },
          { stepId: stepIds[2]!.id, level: 3, approverId: vikram.id, wasStatus: 'WAITING' },
        ],
        approvedLevelsVoided: 1,
      },
    });
    expect(e).toMatchObject({
      step_id: null,
      actor_id: asha.id,
      actor_role: 'CLAIMANT',
      from_status: 'SUBMITTED',
      to_status: 'DRAFT',
      request_id: res.headers.get('x-request-id'),
    });

    // A recalled draft has history: editable and submittable, never deletable
    const del = await callRoute(claimRoute, 'DELETE', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
    });
    expect(await outcome(del)).toEqual([409, 'CLAIM_HAS_HISTORY']);
    // A second recall is not a transition: 409, and no second event
    expect(await outcome(await recall('asha', c.id))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
    expect(await eventTypes(c.id)).toHaveLength(3);
    // The approver's stale tab: meera's step is gone from her queue
    const approve = await callRoute(approveRoute, 'POST', {
      path: `/api/v1/claims/${c.id}/approve`,
      params: { claimId: c.id },
      body: { revision: 1 },
      as: 'meera',
    });
    expect(await outcome(approve)).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    // ...and Ravi, who signed revision 1, is told so
    const again = await callRoute(approveRoute, 'POST', {
      path: `/api/v1/claims/${c.id}/approve`,
      params: { claimId: c.id },
      body: { revision: 1 },
      as: 'ravi',
    });
    expect(await outcome(again)).toEqual([409, 'ALREADY_DECIDED']);
  });

  it('resubmitting at a higher amount builds a fresh chain from the new total (1 → 3 steps)', async () => {
    // ₹9,000 → [ravi]; recalled; edited to ₹75,000 → [ravi, meera, vikram] on revision 2
    const draft = await makeDraft('asha', {
      lines: [{ amountMinor: 900_000, description: 'Venue deposit' }],
    });
    const r1 = await submitAs('asha', draft);
    expect(r1.approval?.steps.map((s) => s.approver.name)).toEqual(['Ravi Menon']);
    const recalled = await recallAs('asha', r1);
    expect(recalled).toMatchObject({ status: 'DRAFT', currentRevision: 1 });

    const edited = await put('asha', r1.id, {
      title: r1.title,
      lineItems: [{ ...lineInput(recalled.lineItems[0]!), amountMinor: 7_500_000 }],
    });
    expect(edited.status).toBe(200);
    const lineId = recalled.lineItems[0]!.id;
    const r2 = await submitAs('asha', r1);

    expect(r2).toMatchObject({
      status: 'SUBMITTED',
      currentRevision: 2,
      totalMinor: 7_500_000,
      allowedActions: ['RECALL'],
    });
    expect(r2.approval?.revision).toBe(2);
    expect(r2.approval?.steps.map((s) => `${s.tierCode}:${s.approver.name}:${s.status}`)).toEqual([
      'L1_MANAGER:Ravi Menon:PENDING',
      'L2_SKIP_LEVEL:Meera Iyer:WAITING',
      'L3_SENIOR_LEADER:Vikram Shah:WAITING',
    ]);
    expect(r2.lineItems.map((l) => l.id)).toEqual([lineId]); // the line kept its id across the edit
    // Revision 1 is history: its one step CANCELLED, its snapshot still the ₹9,000 content
    expect(await allSteps(r1.id)).toEqual([
      'r1:L1:ravi:CANCELLED',
      'r2:L1:ravi:PENDING',
      'r2:L2:meera:WAITING',
      'r2:L3:vikram:WAITING',
    ]);
    expect(
      await ownerSql`
        SELECT revision, total_minor, snapshot->'lines'->0->>'amountMinor' AS line_amount
          FROM claim_submissions WHERE claim_id = ${r1.id} ORDER BY revision`,
    ).toEqual([
      { revision: 1, total_minor: 900_000, line_amount: '900000' },
      { revision: 2, total_minor: 7_500_000, line_amount: '7500000' },
    ]);
    // From a recalled DRAFT the event is CLAIM_SUBMITTED, pointing back at the recalled revision
    expect(await eventTypes(r1.id)).toEqual([
      'CLAIM_SUBMITTED(r1)',
      'CLAIM_RECALLED(r1)',
      'CLAIM_SUBMITTED(r2)',
    ]);
    const [submitted] = await ownerSql<{ payload: Record<string, unknown> }>`
      SELECT payload FROM claim_events WHERE claim_id = ${r1.id} AND revision = 2`;
    expect(submitted!.payload).toMatchObject({
      lineItemCount: 1,
      chain: [{ level: 1 }, { level: 2 }, { level: 3 }],
      previousRevision: { revision: 1, totalMinor: 900_000, outcome: 'RECALLED' },
    });
    // History tells the same story: revision 1 RECALLED, revision 2 in approval
    const h = (await (await history('asha', r1.id)).json()) as { data: ClaimHistory };
    expect(h.data.submissions.map((s) => [s.revision, s.outcome, s.steps.length])).toEqual([
      [1, 'RECALLED', 1],
      [2, 'IN_APPROVAL', 3],
    ]);

    // Approvals never carry over: after L1 approves revision 2 and the claimant recalls again,
    // shrinking it back to ₹9,000 routes from scratch (Ravi signs revision 3 afresh)
    const approved = await approveAs('ravi', r2);
    const again = await recallAs('asha', approved);
    expect(again.approval?.steps.map((s) => s.status)).toEqual([
      'APPROVED',
      'CANCELLED',
      'CANCELLED',
    ]);
    await put('asha', r1.id, {
      title: r1.title,
      lineItems: [{ ...lineInput(again.lineItems[0]!), amountMinor: 900_000 }],
    });
    const r3 = await submitAs('asha', r1);
    expect(r3.approval?.steps.map((s) => `${s.approver.name}:${s.status}`)).toEqual([
      'Ravi Menon:PENDING',
    ]);
    expect(r3).toMatchObject({ currentRevision: 3, totalMinor: 900_000 });
  });

  it('recalling an APPROVED claim returns 409 CLAIM_LOCKED', async () => {
    const c = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] })),
    );
    expect(c.status).toBe('APPROVED');
    const before = await claimRow(c.id);

    const res = await recall('asha', c.id, { note: 'Too late' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toMatchObject({
      code: 'CLAIM_LOCKED',
      details: { status: 'APPROVED' },
    });
    expect(await claimRow(c.id)).toEqual(before);
    expect(await allSteps(c.id)).toEqual(['r1:L1:ravi:APPROVED']);
    expect(await eventTypes(c.id)).toEqual(['CLAIM_SUBMITTED(r1)', 'CLAIM_APPROVED(r1)']);
    // The DB backstop if the service check were bypassed: APPROVED is terminal (UC001)
    await rejects('UC001', () => appSql`UPDATE claims SET status = 'DRAFT' WHERE id = ${c.id}`);

    // Recall is legal only from SUBMITTED: a draft and a rejected claim get 409 too
    const draft = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    const rejected = await rejectAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] })),
    );
    for (const x of [draft, rejected])
      expect([x.status, ...(await outcome(await recall('asha', x.id)))]).toEqual([
        x.status,
        409,
        'INVALID_STATUS_TRANSITION',
      ]);
    expect(await eventTypes(rejected.id)).toEqual(['CLAIM_SUBMITTED(r1)', 'CLAIM_REJECTED(r1)']);
    // A body that breaks RecallInput is a 422 before any lock
    expect(await outcome(await recall('asha', c.id, { note: 'x'.repeat(501) }))).toEqual([
      422,
      'VALIDATION_FAILED',
    ]);
    expect(await outcome(await recall('asha', c.id, { reason: 'unknown key' }))).toEqual([
      422,
      'VALIDATION_FAILED',
    ]);
  });

  it('only the claimant can recall (404 for others)', async () => {
    const c = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] })),
    ); // decided ravi, active meera, waiting vikram
    const fingerprint = () =>
      ownerSql`SELECT
        (SELECT row_to_json(x)::text FROM claims x WHERE x.id = ${c.id}) AS claim,
        (SELECT json_agg(s ORDER BY s.level)::text FROM approval_steps s WHERE s.claim_id = ${c.id}) AS steps,
        (SELECT count(*)::int FROM claim_events e WHERE e.claim_id = ${c.id}) AS events`;
    const before = await fingerprint();
    /** The refusal without its per-request id: it must equal the one for a random UUID. */
    const strip = async (r: Response) => {
      const b = await errorOf(r);
      return { status: r.status, error: { ...b.error, requestId: undefined } };
    };

    for (const as of ['ravi', 'meera', 'vikram', 'neha', 'farah', 'arjun', 'admin'] as const) {
      const mine = await strip(await recall(as, c.id));
      const random = await strip(await recall(as, randomUUID()));
      expect([as, mine]).toEqual([as, random]); // no existence oracle, finance and approvers included
      expect([as, mine.status, mine.error.code]).toEqual([as, 404, 'CLAIM_NOT_FOUND']);
    }
    expect(await fingerprint()).toEqual(before); // nothing changed

    // Positive control: the claimant can
    expect(await outcome(await recall('asha', c.id))).toEqual([200, 'OK']);
    expect((await claimRow(c.id)).status).toBe('DRAFT');
  });

  it('a cancelled approver loses visibility (404)', async () => {
    const c = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] })),
    ); // [ravi APPROVED, meera PENDING]
    // While PENDING, Meera reads the claim and its history
    expect(await outcome(await get('meera', c.id))).toEqual([200, 'OK']);
    expect(await outcome(await history('meera', c.id))).toEqual([200, 'OK']);

    await recallAs('asha', c, 'Adding a missing receipt');
    expect(await allSteps(c.id)).toEqual(['r1:L1:ravi:APPROVED', 'r1:L2:meera:CANCELLED']);

    // CANCELLED grants nothing: the same 404 as for a random id, on the claim and its history
    expect(await outcome(await get('meera', c.id))).toEqual([404, 'CLAIM_NOT_FOUND']);
    expect(await outcome(await history('meera', c.id))).toEqual([404, 'CLAIM_NOT_FOUND']);
    expect(
      await outcome(
        await callRoute(approveRoute, 'POST', {
          path: `/api/v1/claims/${c.id}/approve`,
          params: { claimId: c.id },
          body: { revision: 1 },
          as: 'meera',
        }),
      ),
    ).toEqual([403, 'NOT_IN_YOUR_QUEUE']);
    // Ravi decided revision 1 and keeps read-only access; the owner and finance still read it
    for (const as of ['ravi', 'asha', 'farah'] as const) {
      expect([as, ...(await outcome(await get(as, c.id)))]).toEqual([as, 200, 'OK']);
      expect([as, ...(await outcome(await history(as, c.id)))]).toEqual([as, 200, 'OK']);
    }

    // Resubmitted at ₹8,000 → [ravi]: Meera is not in the new chain, so she stays locked out
    const recalled = (await (await get('asha', c.id)).json()) as { data: ClaimDetail };
    await put('asha', c.id, {
      title: c.title,
      lineItems: [{ ...lineInput(recalled.data.lineItems[0]!), amountMinor: 800_000 }],
    });
    await submitAs('asha', c);
    expect(await outcome(await get('meera', c.id))).toEqual([404, 'CLAIM_NOT_FOUND']);
    expect(await outcome(await history('meera', c.id))).toEqual([404, 'CLAIM_NOT_FOUND']);
  });
});
