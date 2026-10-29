// TC-I23 (§4-d, §6-7, RT-M2): every state change leaves exactly one typed, DB-stamped,
// append-only event, written in the same transaction (02 §10, C-20); the deferred
// assert_transition_audited trigger fails the COMMIT (UC015) without it. P3 covered submit; P4
// adds approve/reject to the first case and the decision-actor case, P5 recall and history. Raw
// forgeries are the SQL proof's G1–G12, as expense_app.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as historyRoute from '@/app/api/v1/claims/[claimId]/history/route';
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route';
import * as rejectRoute from '@/app/api/v1/claims/[claimId]/reject/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import { ClaimEventInputSchema } from '@/server/audit/events';
import { ClaimHistory } from '@/shared/dto/history';
import { asPersona, type Persona } from '../../helpers/auth';
import { appClient, appSql, ownerSql, rejects, tx } from '../../helpers/db';
import {
  approveAs,
  lineInput,
  makeDraft,
  recallAs,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';
import {
  insertEvent,
  rawDecide,
  rawSubmit,
  tierStep,
  type RawEvent,
} from '../../helpers/raw-submit';

const submit = (as: Persona, id: string, headers?: Record<string, string>) =>
  callRoute(submitRoute, 'POST', {
    path: `/api/v1/claims/${id}/submit`,
    params: { claimId: id },
    as,
    headers,
  });

interface EventRow {
  id: string;
  claim_id: string;
  submission_id: string | null;
  step_id: string | null;
  revision: number;
  type: string;
  actor_id: string;
  actor_role: string;
  from_status: string;
  to_status: string;
  total_minor: number;
  reason: string | null;
  payload: Record<string, unknown>;
  request_id: string;
  tx_id: string;
  occurred_at: Date;
}
const decide = (
  route: typeof approveRoute | typeof rejectRoute,
  as: Persona,
  id: string,
  body: Record<string, unknown>,
) =>
  callRoute(route, 'POST', {
    path: `/api/v1/claims/${id}/${route === approveRoute ? 'approve' : 'reject'}`,
    params: { claimId: id },
    body,
    as,
  });

const eventsOf = (claimId: string) =>
  ownerSql<EventRow>`SELECT * FROM claim_events WHERE claim_id = ${claimId} ORDER BY occurred_at, id`;
const countEvents = async (claimId: string) => (await eventsOf(claimId)).length;
/** The claim's workflow footprint: status, revision and row counts. */
const footprint = async (claimId: string) =>
  (
    await ownerSql`
      SELECT c.status, c.current_revision,
             (SELECT count(*)::int FROM claim_submissions s WHERE s.claim_id = c.id) AS submissions,
             (SELECT count(*)::int FROM approval_steps st WHERE st.claim_id = c.id) AS steps,
             (SELECT count(*)::int FROM claim_events e WHERE e.claim_id = c.id) AS events
        FROM claims c WHERE c.id = ${claimId}`
  )[0];

describe('TC-I23 audit trail', () => {
  it('submit, approve (intermediate and final), reject and recall each write exactly one typed event', async () => {
    // P3: submit. P4 extends this case with approve (intermediate and final) and reject, P5 recall.
    const c = await makeDraft('asha', {
      lines: [{ amountMinor: 1_500_000 }, { amountMinor: 1_000_000 }],
    });
    const res = await submit('asha', c.id);
    expect(res.status).toBe(200);

    const events = await eventsOf(c.id);
    expect(events.map((e) => e.type)).toEqual(['CLAIM_SUBMITTED']);
    const e = events[0]!;
    // Typed: the stored row is a valid C-20 CLAIM_SUBMITTED event, payload and all
    const parsed = ClaimEventInputSchema.parse({
      type: e.type,
      claimId: e.claim_id,
      submissionId: e.submission_id,
      revision: e.revision,
      totalMinor: e.total_minor,
      payload: e.payload,
    });
    expect(parsed).toMatchObject({ type: 'CLAIM_SUBMITTED', revision: 1, totalMinor: 2_500_000 });
    expect(e).toMatchObject({
      from_status: 'DRAFT',
      to_status: 'SUBMITTED',
      actor_role: 'CLAIMANT',
      step_id: null,
      reason: null,
    });
    const [sub] = await ownerSql<{ id: string }>`
      SELECT id FROM claim_submissions WHERE claim_id = ${c.id}`;
    expect(e.submission_id).toBe(sub!.id);
    expect(e.payload).toMatchObject({ lineItemCount: 2, chain: [{ level: 1 }, { level: 2 }] });

    // A second claim, a second request: one event each, never shared or duplicated
    const other = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 900 }] }),
    );
    expect(await countEvents(other.id)).toBe(1);
    expect(await countEvents(c.id)).toBe(1);

    // P4: approve (intermediate, then final) — one STEP_APPROVED, then one CLAIM_APPROVED
    const ravi = await asPersona('ravi');
    const meera = await asPersona('meera');
    const vikram = await asPersona('vikram');
    const steps = await ownerSql<{ id: string; level: number }>`
      SELECT id, level FROM approval_steps WHERE claim_id = ${c.id} ORDER BY level`;
    /** The event the request just wrote: exactly one, typed, from → to, by the approver. */
    const lastEvent = async (count: number) => {
      const all = await eventsOf(c.id);
      expect(all).toHaveLength(count); // exactly one more than before
      const ev = all.at(-1)!;
      return {
        row: ev,
        parsed: ClaimEventInputSchema.parse({
          type: ev.type,
          claimId: ev.claim_id,
          submissionId: ev.submission_id,
          stepId: ev.step_id,
          revision: ev.revision,
          totalMinor: ev.total_minor,
          ...(ev.reason !== null && { reason: ev.reason }),
          payload: ev.payload,
        }),
      };
    };
    const intermediate = await decide(approveRoute, 'ravi', c.id, { revision: 1, comment: 'OK' });
    expect(intermediate.status).toBe(200);
    const stepApproved = await lastEvent(2);
    expect(stepApproved.parsed).toEqual({
      type: 'STEP_APPROVED',
      claimId: c.id,
      submissionId: sub!.id,
      stepId: steps[0]!.id,
      revision: 1,
      totalMinor: 2_500_000,
      reason: 'OK',
      payload: { level: 1, levelCount: 2, tierCode: 'L1_MANAGER', nextApproverId: meera.id },
    });
    expect(stepApproved.row).toMatchObject({
      from_status: 'SUBMITTED',
      to_status: 'SUBMITTED',
      actor_id: ravi.id,
      actor_role: 'APPROVER',
      request_id: intermediate.headers.get('x-request-id'),
    });

    const final = await decide(approveRoute, 'meera', c.id, { revision: 1 });
    expect(final.status).toBe(200);
    const claimApproved = await lastEvent(3);
    expect(claimApproved.parsed).toEqual({
      type: 'CLAIM_APPROVED',
      claimId: c.id,
      submissionId: sub!.id,
      stepId: steps[1]!.id,
      revision: 1,
      totalMinor: 2_500_000,
      payload: {
        level: 2,
        levelCount: 2,
        tierCode: 'L2_SKIP_LEVEL',
        approverIds: [ravi.id, meera.id],
      },
    });
    expect(claimApproved.row).toMatchObject({
      from_status: 'SUBMITTED',
      to_status: 'APPROVED',
      actor_id: meera.id,
      actor_role: 'APPROVER',
      reason: null,
    });
    // A refused decision (already decided) writes nothing
    expect((await decide(approveRoute, 'meera', c.id, { revision: 1 })).status).toBe(409);
    expect(await countEvents(c.id)).toBe(3);

    // P4: reject — one CLAIM_REJECTED that carries the cancelled later steps
    const r = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] })),
    ); // [ravi APPROVED, meera PENDING, vikram WAITING]
    const rSteps = await ownerSql<{ id: string }>`
      SELECT id FROM approval_steps WHERE claim_id = ${r.id} ORDER BY level`;
    const rejected = await decide(rejectRoute, 'meera', r.id, {
      revision: 1,
      reason: 'Venue quote is not itemised',
    });
    expect(rejected.status).toBe(200);
    const rEvents = await eventsOf(r.id);
    expect(rEvents.map((e) => e.type)).toEqual([
      'CLAIM_SUBMITTED',
      'STEP_APPROVED',
      'CLAIM_REJECTED',
    ]);
    const rej = rEvents[2]!;
    expect(
      ClaimEventInputSchema.parse({
        type: rej.type,
        claimId: rej.claim_id,
        submissionId: rej.submission_id,
        stepId: rej.step_id,
        revision: rej.revision,
        totalMinor: rej.total_minor,
        reason: rej.reason,
        payload: rej.payload,
      }),
    ).toMatchObject({
      type: 'CLAIM_REJECTED',
      stepId: rSteps[1]!.id,
      reason: 'Venue quote is not itemised',
      payload: {
        level: 2,
        levelCount: 3,
        tierCode: 'L2_SKIP_LEVEL',
        cancelledStepIds: [rSteps[2]!.id], // the cascade rides in the payload: no event of its own
      },
    });
    expect(rej).toMatchObject({
      from_status: 'SUBMITTED',
      to_status: 'REJECTED',
      actor_id: meera.id,
      actor_role: 'APPROVER',
      request_id: rejected.headers.get('x-request-id'),
    });
    expect(rEvents.map((e) => e.actor_id)).not.toContain(vikram.id); // a cancelled step is no event

    // P5: recall — one CLAIM_RECALLED that carries the cancelled steps and the voided approvals
    const asha = await asPersona('asha');
    const k = await approveAs(
      'ravi',
      await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] })),
    ); // [ravi APPROVED, meera PENDING, vikram WAITING]
    const kSteps = await ownerSql<{ id: string }>`
      SELECT id FROM approval_steps WHERE claim_id = ${k.id} ORDER BY level`;
    const recalled = await callRoute(recallRoute, 'POST', {
      path: `/api/v1/claims/${k.id}/recall`,
      params: { claimId: k.id },
      body: { note: 'Venue invoice to follow' },
      as: 'asha',
    });
    expect(recalled.status).toBe(200);
    const kEvents = await eventsOf(k.id);
    expect(kEvents.map((e) => e.type)).toEqual([
      'CLAIM_SUBMITTED',
      'STEP_APPROVED',
      'CLAIM_RECALLED',
    ]);
    const rec = kEvents[2]!;
    expect(
      ClaimEventInputSchema.parse({
        type: rec.type,
        claimId: rec.claim_id,
        submissionId: rec.submission_id,
        revision: rec.revision,
        totalMinor: rec.total_minor,
        reason: rec.reason,
        payload: rec.payload,
      }),
    ).toEqual({
      type: 'CLAIM_RECALLED',
      claimId: k.id,
      submissionId: kEvents[0]!.submission_id,
      revision: 1,
      totalMinor: 7_500_000,
      reason: 'Venue invoice to follow',
      payload: {
        cancelledSteps: [
          { stepId: kSteps[1]!.id, level: 2, approverId: meera.id, wasStatus: 'PENDING' },
          { stepId: kSteps[2]!.id, level: 3, approverId: vikram.id, wasStatus: 'WAITING' },
        ],
        approvedLevelsVoided: 1,
      },
    });
    expect(rec).toMatchObject({
      step_id: null,
      from_status: 'SUBMITTED',
      to_status: 'DRAFT',
      actor_id: asha.id,
      actor_role: 'CLAIMANT',
      request_id: recalled.headers.get('x-request-id'),
    });
    // A refused recall (already a DRAFT) writes nothing
    const refused = await callRoute(recallRoute, 'POST', {
      path: `/api/v1/claims/${k.id}/recall`,
      params: { claimId: k.id },
      as: 'asha',
    });
    expect([refused.status, (await errorOf(refused)).error.code]).toEqual([
      409,
      'INVALID_STATUS_TRANSITION',
    ]);
    expect(await countEvents(k.id)).toBe(3);
  });

  it('event request_id equals the response x-request-id', async () => {
    // Generated: no inbound id
    const a = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const resA = await submit('asha', a.id);
    const generated = resA.headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect((await eventsOf(a.id)).map((e) => e.request_id)).toEqual([generated]);

    // Echoed: a valid inbound id is kept end to end (log ↔ event join, D-40)
    const b = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const inbound = `audit-${randomUUID()}`.slice(0, 40);
    const resB = await submit('asha', b.id, { 'x-request-id': inbound });
    expect(resB.headers.get('x-request-id')).toBe(inbound);
    expect((await eventsOf(b.id)).map((e) => e.request_id)).toEqual([inbound]);

    // Replaced: an invalid inbound id never reaches the table
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const resC = await submit('asha', c.id, { 'x-request-id': 'bad id; DROP TABLE claims' });
    const replaced = resC.headers.get('x-request-id');
    expect(replaced).not.toBe('bad id; DROP TABLE claims');
    expect((await eventsOf(c.id)).map((e) => e.request_id)).toEqual([replaced]);
  });

  it('event actor is the authenticated actor', async () => {
    const asha = await asPersona('asha');
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    expect((await submit('asha', c.id)).status).toBe(200);
    expect((await eventsOf(c.id)).map((e) => [e.actor_id, e.actor_role])).toEqual([
      [asha.id, 'CLAIMANT'],
    ]);

    // The DB refuses a submit whose event names anyone but the claimant (proof G7), or the
    // claimant in the wrong role
    const ravi = await asPersona('ravi');
    const d = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const chain = [tierStep(1, ravi.id)];
    await rejects('UC015', async () =>
      rawSubmit(await appClient(), d.id, { chain, event: (e) => ({ ...e, actorId: ravi.id }) }),
    );
    await rejects('UC015', async () =>
      rawSubmit(await appClient(), d.id, {
        chain,
        event: (e) => ({ ...e, actorRole: 'APPROVER' }),
      }),
    );
    expect(await footprint(d.id)).toEqual({
      status: 'DRAFT',
      current_revision: 0,
      submissions: 0,
      steps: 0,
      events: 0,
    });
  });

  it('a failed transition writes no event', async () => {
    const empty = await makeDraft('asha');
    const vikram = await makeDraft('vikram', { lines: [{ amountMinor: 2_500_000 }] });
    const foreign = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const retired = await makeDraft('asha', {
      lines: [
        { amountMinor: 800_000, expenseDate: '2026-10-01' },
        { amountMinor: 500, category: 'MISC', expenseDate: '2026-10-02' }, // detail order: index 1
      ],
    });
    await ownerSql`UPDATE categories SET is_active = false WHERE code = 'MISC'`; // retired after saving
    const twice = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 900 }] }),
    );

    const failures: [string, Response][] = [
      ['NO_LINE_ITEMS', await submit('asha', empty.id)],
      ['ROUTING_UNRESOLVABLE', await submit('vikram', vikram.id)],
      ['CLAIM_NOT_FOUND', await submit('neha', foreign.id)],
      ['CATEGORY_INACTIVE', await submit('asha', retired.id)],
      ['INVALID_STATUS_TRANSITION', await submit('asha', twice.id)],
    ];
    const bodies = await Promise.all(failures.map(([, res]) => errorOf(res)));
    expect(bodies.map((b) => b.error.code)).toEqual(failures.map(([code]) => code));
    expect(bodies[3]!.error.details).toEqual({
      issues: [
        expect.objectContaining({
          path: ['lineItems', 1, 'categoryId'],
          code: 'CATEGORY_INACTIVE',
        }),
      ],
    });

    for (const c of [empty, vikram, foreign, retired]) expect(await countEvents(c.id)).toBe(0);
    expect(await countEvents(twice.id)).toBe(1); // only the successful first submit

    // A DB backstop failure rolls the event back with everything else (UC012 here)
    const ravi = await asPersona('ravi');
    const big = await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] });
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), big.id, { chain: [tierStep(1, ravi.id)] }),
    );
    expect(await countEvents(big.id)).toBe(0);
  });

  it('a status change without an event fails at COMMIT with UC015', async () => {
    const ravi = await asPersona('ravi');
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const chain = [tierStep(1, ravi.id)];
    const untouched = await footprint(c.id);

    // No event at all (proof G5 for submit): the deferred check fires at COMMIT
    await rejects('UC015', async () =>
      rawSubmit(await appClient(), c.id, { chain, event: () => null }),
    );
    expect(await footprint(c.id)).toEqual(untouched); // nothing persisted

    // An event that doesn't match the transition: wrong type (G10), revision, from-status or
    // submission
    for (const forge of [
      { type: 'CLAIM_RESUBMITTED' },
      { revision: 2 },
      { fromStatus: 'REJECTED' },
      { submissionId: null },
    ])
      await rejects('UC015', async () =>
        rawSubmit(await appClient(), c.id, { chain, event: (e) => ({ ...e, ...forge }) }),
      );

    // An event committed in an EARLIER transaction doesn't satisfy a later transition (G9). The
    // app may insert a stand-alone event (C-16, accepted residual RT-M2), but it changes nothing.
    const asha = await asPersona('asha');
    const early = await appClient();
    await tx(early, () =>
      insertEvent(early.sql, c.id, {
        type: 'CLAIM_SUBMITTED',
        actorId: asha.id,
        actorRole: 'CLAIMANT',
        fromStatus: 'DRAFT',
        toStatus: 'SUBMITTED',
        revision: 1,
        submissionId: null,
        totalMinor: 800_000,
        payload: {},
        requestId: `test-${randomUUID()}`,
      }),
    );
    expect((await footprint(c.id))?.status).toBe('DRAFT');
    await rejects('UC015', async () =>
      rawSubmit(await appClient(), c.id, { chain, event: () => null }),
    );
    expect(await footprint(c.id)).toEqual({ ...untouched, events: 1 });

    // Positive control: the honest transaction commits
    await rawSubmit(await appClient(), c.id, { chain });
    expect(await footprint(c.id)).toEqual({
      status: 'SUBMITTED',
      current_revision: 1,
      submissions: 1,
      steps: 1,
      events: 2,
    });
  });

  it('a decision event whose actor is not the step approver fails at COMMIT with UC015', async () => {
    const asha = await asPersona('asha');
    const ravi = await asPersona('ravi');
    const meera = await asPersona('meera');
    const neha = await asPersona('neha');
    // Proof G8: the steps and the claim move honestly; only the event lies about who decided
    const two = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
    ); // [ravi PENDING, meera WAITING]
    const one = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] }),
    ); // [ravi PENDING]: the final level, so the claim's own transition is checked too
    const before = { two: await footprint(two.id), one: await footprint(one.id) };
    const [otherStep] = await ownerSql<{ id: string }>`
      SELECT id FROM approval_steps WHERE claim_id = ${two.id} AND level = 2`;

    const forgeries: [string, (e: RawEvent) => RawEvent][] = [
      ['another approver', (e) => ({ ...e, actorId: neha.id })],
      ['the next approver in the chain', (e) => ({ ...e, actorId: meera.id })],
      ['the claimant', (e) => ({ ...e, actorId: asha.id })],
      ['the claimant as CLAIMANT', (e) => ({ ...e, actorId: asha.id, actorRole: 'CLAIMANT' })],
      ['the right approver as CLAIMANT', (e) => ({ ...e, actorRole: 'CLAIMANT' })],
      ['another step of the chain', (e) => ({ ...e, stepId: otherStep!.id })],
    ];
    for (const [claim, outcome] of [
      [two, 'APPROVED'], // intermediate approval: STEP_APPROVED (the step check)
      [one, 'APPROVED'], // final approval: CLAIM_APPROVED (step and claim checks)
      [two, 'REJECTED'], // rejection: CLAIM_REJECTED (step and claim checks)
    ] as const)
      for (const [label, forge] of forgeries) {
        const err = await rejects('UC015', async () =>
          rawDecide(await appClient(), claim.id, { approverId: ravi.id, outcome, event: forge }),
        );
        expect([outcome, label, String((err as Error).message)]).toEqual([
          outcome,
          label,
          expect.stringContaining('AUDIT_EVENT_MISSING'),
        ]);
      }
    // ... and with no event at all (G5 for decisions)
    await rejects('UC015', async () =>
      rawDecide(await appClient(), two.id, {
        approverId: ravi.id,
        outcome: 'APPROVED',
        event: () => null,
      }),
    );
    expect(await footprint(two.id)).toEqual(before.two); // every attempt rolled back whole
    expect(await footprint(one.id)).toEqual(before.one);

    // Positive control: the honest raw transaction commits (so the helper itself is sound)
    await rawDecide(await appClient(), two.id, { approverId: ravi.id, outcome: 'APPROVED' });
    await rawDecide(await appClient(), one.id, { approverId: ravi.id, outcome: 'REJECTED' });
    expect((await footprint(two.id))?.events).toBe(2);
    expect(await footprint(one.id)).toMatchObject({ status: 'REJECTED', events: 2 });
  });

  it('claim_events rejects UPDATE and DELETE (42501 / UC007)', async () => {
    const c = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
    );
    const before = await eventsOf(c.id);
    const [sub] = await ownerSql<{
      id: string;
    }>`SELECT id FROM claim_submissions WHERE claim_id = ${c.id}`;

    // The app role has no UPDATE or DELETE grant at all...
    await rejects(
      '42501',
      () => appSql`UPDATE claim_events SET reason = 'edited' WHERE claim_id = ${c.id}`,
    );
    await rejects(
      '42501',
      () => appSql`UPDATE claim_events SET occurred_at = now() - interval '9 days'`,
    );
    await rejects('42501', () => appSql`DELETE FROM claim_events WHERE claim_id = ${c.id}`);
    await rejects('42501', () => appSql`TRUNCATE claim_events`);
    // ...and even the owner hits the append-only trigger (a DB rule, not only a privilege)
    await rejects(
      'UC007',
      () => ownerSql`UPDATE claim_events SET reason = 'edited' WHERE claim_id = ${c.id}`,
    );
    await rejects('UC007', () => ownerSql`DELETE FROM claim_events WHERE claim_id = ${c.id}`);
    // The same for the submission it points at, and the chain's steps can't be deleted
    await rejects(
      '42501',
      () => appSql`UPDATE claim_submissions SET total_minor = 1 WHERE id = ${sub!.id}`,
    );
    await rejects('42501', () => appSql`DELETE FROM claim_submissions WHERE id = ${sub!.id}`);
    await rejects(
      'UC007',
      () => ownerSql`UPDATE claim_submissions SET total_minor = 1 WHERE id = ${sub!.id}`,
    );
    await rejects('UC007', () => ownerSql`DELETE FROM claim_submissions WHERE id = ${sub!.id}`);
    await rejects('42501', () => appSql`DELETE FROM approval_steps WHERE claim_id = ${c.id}`);
    await rejects('UC007', () => ownerSql`DELETE FROM approval_steps WHERE claim_id = ${c.id}`);
    expect(await eventsOf(c.id)).toEqual(before);

    // An app INSERT is DB-stamped: a supplied occurred_at or tx_id is overwritten (proof G4)
    const asha = await asPersona('asha');
    const app = await appClient();
    const stamped = await tx(app, async () => {
      const [now] = await app.sql<{ now: Date; xid: string }>`
        SELECT now()::timestamptz(3) AS now, pg_current_xact_id()::text AS xid`;
      const [row] = await app.sql<{ occurred_at: Date; tx_id: string }>`
        INSERT INTO claim_events (claim_id, submission_id, revision, type, actor_id, actor_role,
                                  from_status, to_status, total_minor, request_id, occurred_at, tx_id)
        VALUES (${c.id}, ${sub!.id}, 1, 'CLAIM_RECALLED', ${asha.id}, 'CLAIMANT', 'SUBMITTED',
                'DRAFT', ${c.totalMinor}, ${`test-${randomUUID()}`}, '2020-01-01T00:00:00Z', 1)
        RETURNING occurred_at, tx_id::text AS tx_id`;
      return { ...row!, ...now! };
    });
    expect(stamped.occurred_at.toISOString()).toBe(stamped.now.toISOString());
    expect(stamped.tx_id).toBe(stamped.xid);
    expect((await footprint(c.id))?.status).toBe('SUBMITTED'); // a stand-alone event changes no state
  });

  it('GET /claims/:id/history returns ordered events to authorized viewers only', async () => {
    const history = (as: Persona, id: string) =>
      callRoute(historyRoute, 'GET', {
        path: `/api/v1/claims/${id}/history`,
        params: { claimId: id },
        as,
      });
    const asha = await asPersona('asha');
    const ravi = await asPersona('ravi');
    const meera = await asPersona('meera');

    // C06's story: rev 1 ₹30,000 → [ravi, meera]; Ravi approves; Meera rejects; Asha edits it
    // down to ₹9,500 and resubmits → rev 2 [ravi PENDING]
    const draft = await makeDraft('asha', {
      lines: [
        { amountMinor: 2_200_000, category: 'TRAVEL_AIR' },
        { amountMinor: 800_000, category: 'LODGING' },
      ],
    });
    const rejected = await rejectAs(
      'meera',
      await approveAs('ravi', await submitAs('asha', draft), { comment: 'Fine by me' }),
      'Business fare is outside the travel policy',
    );
    const edit = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${draft.id}`,
      params: { claimId: draft.id },
      body: {
        title: rejected.title,
        lineItems: rejected.lineItems.map((l) => ({
          ...lineInput(l),
          amountMinor: l.amountMinor === 2_200_000 ? 350_000 : 600_000,
        })),
      },
      as: 'asha',
    });
    expect(edit.status).toBe(200);
    await submitAs('asha', draft);

    const res = await history('asha', draft.id);
    expect(res.status).toBe(200);
    const h = ClaimHistory.parse(((await res.json()) as { data: unknown }).data); // C-10 contract

    // Events: every row, oldest first in (occurred_at, id) order, each with its actor and request id
    const rows = await eventsOf(draft.id);
    expect(h.events.map((e) => [e.type, e.revision])).toEqual([
      ['CLAIM_SUBMITTED', 1],
      ['STEP_APPROVED', 1],
      ['CLAIM_REJECTED', 1],
      ['CLAIM_RESUBMITTED', 2],
    ]);
    expect(h.events).toEqual(
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        occurredAt: r.occurred_at.toISOString(),
        actor: {
          id: r.actor_id,
          name: { [asha.id]: 'Asha Rao', [ravi.id]: 'Ravi Menon', [meera.id]: 'Meera Iyer' }[
            r.actor_id
          ],
        },
        actorRole: r.actor_role,
        revision: r.revision,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        reason: r.reason,
        payload: r.payload,
        requestId: r.request_id,
      })),
    );
    expect(h.events.map((e) => e.reason)).toEqual([
      null,
      'Fine by me',
      'Business fare is outside the travel policy',
      null,
    ]);
    const times = h.events.map((e) => Date.parse(e.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // Submissions: both revisions, each with its frozen total, derived outcome and its own chain
    expect(
      h.submissions.map((s) => ({
        revision: s.revision,
        totalMinor: s.totalMinor,
        snapshotTotal: s.snapshot.totalMinor,
        lineItemCount: s.lineItemCount,
        outcome: s.outcome,
        steps: s.steps.map((st) => `${st.approver.name}:${st.status}`),
      })),
    ).toEqual([
      {
        revision: 1,
        totalMinor: 3_000_000,
        snapshotTotal: 3_000_000,
        lineItemCount: 2,
        outcome: 'REJECTED',
        steps: ['Ravi Menon:APPROVED', 'Meera Iyer:REJECTED'],
      },
      {
        revision: 2,
        totalMinor: 950_000,
        snapshotTotal: 950_000,
        lineItemCount: 2,
        outcome: 'IN_APPROVAL',
        steps: ['Ravi Menon:PENDING'],
      },
    ]);

    // Authorized viewers (owner, the approvers who acted, finance) get the same trail
    const body = JSON.stringify(h);
    for (const as of ['ravi', 'meera', 'farah'] as const) {
      const r = await history(as, draft.id);
      expect([as, r.status]).toEqual([as, 200]);
      expect([
        as,
        JSON.stringify(ClaimHistory.parse(((await r.json()) as { data: unknown }).data)),
      ]).toEqual([as, body]);
    }
    // Everyone else: the 404 for a random id (no existence oracle), and no trail
    const strip = async (r: Response) => {
      const b = await errorOf(r);
      return { status: r.status, error: { ...b.error, requestId: undefined } };
    };
    const random = await strip(await history('neha', randomUUID()));
    expect(random).toMatchObject({ status: 404, error: { code: 'CLAIM_NOT_FOUND' } });
    for (const as of ['neha', 'vikram', 'arjun', 'deepa', 'admin'] as const)
      expect([as, await strip(await history(as, draft.id))]).toEqual([as, random]);

    // WAITING and CANCELLED steps grant nothing either
    const waiting = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
    ); // [ravi PENDING, meera WAITING]
    expect(await strip(await history('meera', waiting.id))).toEqual(random);
    await recallAs('asha', await approveAs('ravi', waiting)); // meera PENDING → CANCELLED
    expect(await strip(await history('meera', waiting.id))).toEqual(random);
    expect((await history('ravi', waiting.id)).status).toBe(200); // he decided revision 1

    // A never-submitted draft has no history yet, and it is still the owner's alone
    const fresh = await makeDraft('asha');
    const empty = await history('asha', fresh.id);
    expect([empty.status, await empty.json()]).toEqual([
      200,
      { data: { submissions: [], events: [] } },
    ]);
    expect(await strip(await history('ravi', fresh.id))).toEqual(random);
  });
});
