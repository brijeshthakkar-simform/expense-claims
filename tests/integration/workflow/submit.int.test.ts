// TC-I15 (§6-1, §3.2, §4-b, RT-M1): POST /api/v1/claims/:claimId/submit through the real route,
// and the DB backstops behind it (02 §4.6, 03 §16.5): claims_guard v2, claim_submissions_verify,
// approval_steps_guard. Raw forgeries run as expense_app through tests/helpers/raw-submit.ts, the
// SQL proof's F1–F4, I1, I6–I9 and I17–I19 ported.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import { ClaimDetail } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { appClient, appSql, ownerSql, rejects } from '../../helpers/db';
import { categoryIds, makeDraft } from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';
import { rawSubmit, snapshotOf, tierStep } from '../../helpers/raw-submit';

const submit = (as: Persona, id: string, body?: unknown) =>
  callRoute(submitRoute, 'POST', {
    path: `/api/v1/claims/${id}/submit`,
    params: { claimId: id },
    as,
    body,
  });
/** The error body without its per-request id. */
const bodyOf = async (r: Response) => {
  const b = await errorOf(r);
  return { status: r.status, error: { ...b.error, requestId: undefined } };
};
/** The claim row, its lines and everything the workflow hangs off it, as text. */
const stateOf = async (id: string) =>
  (
    await ownerSql<{ s: string }>`SELECT json_build_object(
      'claim', (SELECT row_to_json(c) FROM claims c WHERE c.id = ${id}),
      'lines', (SELECT json_agg(l ORDER BY l.id) FROM line_items l WHERE l.claim_id = ${id}),
      'submissions', (SELECT count(*) FROM claim_submissions WHERE claim_id = ${id}),
      'steps', (SELECT count(*) FROM approval_steps WHERE claim_id = ${id}),
      'events', (SELECT count(*) FROM claim_events WHERE claim_id = ${id}))::text AS s`
  )[0]!.s;
const ids = async () => {
  const [asha, ravi, meera, vikram] = await Promise.all(
    (['asha', 'ravi', 'meera', 'vikram'] as const).map(async (p) => (await asPersona(p)).id),
  );
  return { asha: asha!, ravi: ravi!, meera: meera!, vikram: vikram! };
};

describe('TC-I15 submit', () => {
  it('submitting a claim with zero line items returns 422 NO_LINE_ITEMS', async () => {
    const c = await makeDraft('asha');
    const before = await stateOf(c.id);

    const res = await submit('asha', c.id);
    expect(await bodyOf(res)).toEqual({
      status: 422,
      error: expect.objectContaining({ code: 'NO_LINE_ITEMS' }),
    });
    // A claim emptied by PUT is the same case
    const emptied = await makeDraft('asha', { lines: [{ amountMinor: 500 }] });
    await ownerSql`DELETE FROM line_items WHERE claim_id = ${emptied.id}`;
    expect((await errorOf(await submit('asha', emptied.id))).error.code).toBe('NO_LINE_ITEMS');

    expect(await stateOf(c.id)).toBe(before); // still DRAFT rev 0: no submission, step or event
  });

  it("raw UPDATE claims SET status='SUBMITTED' on an empty claim raises UC004", async () => {
    const c = await makeDraft('asha');
    const before = await stateOf(c.id);
    // claims_guard (a): zero lines is never submittable, as the app or as the owner
    await rejects(
      'UC004',
      () => appSql`UPDATE claims SET status = 'SUBMITTED', current_revision = 1 WHERE id = ${c.id}`,
    );
    await rejects(
      'UC004',
      () =>
        ownerSql`UPDATE claims SET status = 'SUBMITTED', current_revision = 1 WHERE id = ${c.id}`,
    );
    // claim_submissions_verify: an empty claim can't get a submission either...
    const { ravi } = await ids();
    await rejects('UC004', async () =>
      rawSubmit(await appClient(), c.id, { chain: [tierStep(1, ravi)] }),
    );
    // ...nor can a claim that has lines get an empty snapshot (proof F3)
    const withLines = await makeDraft('asha', { lines: [{ amountMinor: 100 }] });
    await rejects('UC004', async () =>
      rawSubmit(await appClient(), withLines.id, {
        chain: [tierStep(1, ravi)],
        snapshot: (s) => ({ ...s, lines: [] }),
      }),
    );
    expect(await stateOf(c.id)).toBe(before);
  });

  it('submit creates revision 1, a snapshot, a chain from the total and one CLAIM_SUBMITTED event', async () => {
    const cats = await categoryIds();
    const c = await makeDraft('asha', {
      title: 'Hyderabad client visit',
      lines: [
        { amountMinor: 1_500_000, category: 'LODGING', expenseDate: '2026-10-02' },
        {
          amountMinor: 1_000_000,
          category: 'TRAVEL_AIR',
          expenseDate: '2026-10-01',
          merchant: 'IndiGo',
        },
      ],
    }); // ₹25,000 → [ravi, meera]
    const { asha, ravi, meera } = await ids();

    const res = await submit('asha', c.id); // no body at all: the body is optional
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: unknown };
    const detail = ClaimDetail.parse(data);
    expect(detail).toMatchObject({
      id: c.id,
      claimNumber: c.claimNumber,
      status: 'SUBMITTED',
      currentRevision: 1,
      totalMinor: 2_500_000,
      approvedAt: null,
      rejectedAt: null,
      lastRejection: null,
      allowedActions: ['RECALL'], // no EDIT, SUBMIT or DELETE while in approval
    });
    expect(detail.submittedAt).not.toBeNull();
    expect(detail.approval?.revision).toBe(1);
    expect(
      detail.approval?.steps.map((s) => [
        s.level,
        s.tierCode,
        s.tierLabel,
        s.approver.id,
        s.status,
      ]),
    ).toEqual([
      [1, 'L1_MANAGER', 'Line manager', ravi, 'PENDING'],
      [2, 'L2_SKIP_LEVEL', 'Skip-level manager', meera, 'WAITING'],
    ]);
    expect(detail.approval?.steps[0]?.activatedAt).toBe(detail.submittedAt);
    expect(detail.approval?.steps[1]?.activatedAt).toBeNull();

    // The claim points at its new submission
    const [claim] = await ownerSql<{
      status: string;
      current_revision: number;
      current_submission_id: string;
      submitted_at: Date;
    }>`SELECT status, current_revision, current_submission_id, submitted_at FROM claims
        WHERE id = ${c.id}`;
    const subs = await ownerSql<{
      id: string;
      revision: number;
      submitted_by_id: string;
      total_minor: number;
      currency: string;
      line_item_count: number;
      submitted_at: Date;
      snapshot: unknown;
    }>`SELECT id, revision, submitted_by_id, total_minor, currency, line_item_count, submitted_at,
              snapshot FROM claim_submissions WHERE claim_id = ${c.id}`;
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(claim).toMatchObject({
      status: 'SUBMITTED',
      current_revision: 1,
      current_submission_id: sub.id,
    });
    expect(sub).toMatchObject({
      revision: 1,
      submitted_by_id: asha,
      total_minor: 2_500_000,
      currency: 'INR',
      line_item_count: 2,
    });
    // The snapshot (C-21): claimant, header and lines with the frozen category name and GL code,
    // in (expenseDate, id) order, equal to the live rows
    expect(sub.snapshot).toEqual(await snapshotOf(ownerSql, c.id));
    expect(sub.snapshot).toEqual({
      v: 1,
      claimant: {
        id: asha,
        employeeCode: 'E1001',
        name: 'Asha Rao',
        email: 'asha.rao@acme.test',
        departmentCode: 'ENG',
      },
      title: 'Hyderabad client visit',
      currency: 'INR',
      totalMinor: 2_500_000,
      lines: [
        {
          lineItemId: expect.any(String),
          expenseDate: '2026-10-01',
          categoryId: cats.TRAVEL_AIR,
          categoryCode: 'TRAVEL_AIR',
          categoryName: 'Air travel',
          glCode: '6101',
          amountMinor: 1_000_000,
          description: 'Test expense',
          merchant: 'IndiGo',
          receipts: [],
        },
        {
          lineItemId: expect.any(String),
          expenseDate: '2026-10-02',
          categoryId: cats.LODGING,
          categoryCode: 'LODGING',
          categoryName: 'Hotels & lodging',
          glCode: '6110',
          amountMinor: 1_500_000,
          description: 'Test expense',
          merchant: null,
          receipts: [],
        },
      ],
    });

    // The chain from the total: tier copies, level 1 PENDING (activated), level 2 WAITING
    const steps = await ownerSql`
      SELECT level, tier_code, tier_label, applies_above_minor, approver_id, resolved_via, status,
             activated_at, decided_at, cancelled_at
        FROM approval_steps WHERE submission_id = ${sub.id} ORDER BY level`;
    expect(steps).toEqual([
      {
        level: 1,
        tier_code: 'L1_MANAGER',
        tier_label: 'Line manager',
        applies_above_minor: 0,
        approver_id: ravi,
        resolved_via: 'PRIMARY',
        status: 'PENDING',
        activated_at: sub.submitted_at,
        decided_at: null,
        cancelled_at: null,
      },
      {
        level: 2,
        tier_code: 'L2_SKIP_LEVEL',
        tier_label: 'Skip-level manager',
        applies_above_minor: 1_000_000,
        approver_id: meera,
        resolved_via: 'PRIMARY',
        status: 'WAITING',
        activated_at: null,
        decided_at: null,
        cancelled_at: null,
      },
    ]);

    // Exactly one typed event, at the same DB instant as the transition
    const events = await ownerSql`
      SELECT type, actor_id, actor_role, from_status, to_status, revision, submission_id,
             step_id, total_minor, reason, payload, occurred_at
        FROM claim_events WHERE claim_id = ${c.id}`;
    expect(events).toEqual([
      {
        type: 'CLAIM_SUBMITTED',
        actor_id: asha,
        actor_role: 'CLAIMANT',
        from_status: 'DRAFT',
        to_status: 'SUBMITTED',
        revision: 1,
        submission_id: sub.id,
        step_id: null,
        total_minor: 2_500_000,
        reason: null,
        payload: {
          lineItemCount: 2,
          chain: [
            { level: 1, tierCode: 'L1_MANAGER', approverId: ravi, resolvedVia: 'PRIMARY' },
            { level: 2, tierCode: 'L2_SKIP_LEVEL', approverId: meera, resolvedVia: 'PRIMARY' },
          ],
        },
        occurred_at: sub.submitted_at,
      },
    ]);
    expect(claim!.submitted_at.toISOString()).toBe(sub.submitted_at.toISOString());
    expect(detail.submittedAt).toBe(sub.submitted_at.toISOString());
  });

  it('submitting a SUBMITTED claim returns 409 INVALID_STATUS_TRANSITION', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    expect((await submit('asha', c.id, {})).status).toBe(200);
    const after = await stateOf(c.id);

    const again = await submit('asha', c.id, {});
    expect(await bodyOf(again)).toEqual({
      status: 409,
      error: expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    });
    expect(await stateOf(c.id)).toBe(after); // still one submission, one chain, one event
    const [counts] = await ownerSql`
      SELECT (SELECT count(*)::int FROM claim_submissions WHERE claim_id = ${c.id}) AS submissions,
             (SELECT count(*)::int FROM claim_events WHERE claim_id = ${c.id}) AS events`;
    expect(counts).toEqual({ submissions: 1, events: 1 });

    // A body other than {} is refused before anything is read (the schema is strict)
    const bad = await submit('asha', c.id, { revision: 1 });
    expect([bad.status, (await errorOf(bad)).error.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it("submitting someone else's claim returns 404 CLAIM_NOT_FOUND", async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const before = await stateOf(c.id);
    const random = randomUUID();
    // ravi: Asha's own manager; neha: an unrelated approver; farah: FINANCE (reads drafts, never
    // writes them); arjun and admin: unrelated
    for (const who of ['ravi', 'neha', 'farah', 'arjun', 'admin'] as const) {
      const [real, none] = [
        await bodyOf(await submit(who, c.id)),
        await bodyOf(await submit(who, random)),
      ];
      expect([who, real]).toEqual([
        who,
        { status: 404, error: expect.objectContaining({ code: 'CLAIM_NOT_FOUND' }) },
      ]);
      expect([who, real]).toEqual([who, none]); // identical to a random id
    }
    expect(await stateOf(c.id)).toBe(before);
    // ...and once Asha submits it, the others still can't (no state leaks through the code)
    expect((await submit('asha', c.id)).status).toBe(200);
    expect(await bodyOf(await submit('ravi', c.id))).toEqual(
      await bodyOf(await submit('ravi', random)),
    );
  });

  it('a raw chain shorter than the applicable tiers is refused with UC012', async () => {
    const { ravi, meera, vikram } = await ids();
    // Under-approval (proof I6): ₹75,000 needs 3 levels; 1 or 2 steps can't reach SUBMITTED
    const big = await makeDraft('asha', { lines: [{ amountMinor: 7_500_000 }] });
    const before = await stateOf(big.id);
    for (const chain of [[tierStep(1, ravi)], [tierStep(1, ravi), tierStep(2, meera)]])
      await rejects('UC012', async () => rawSubmit(await appClient(), big.id, { chain }));
    expect(await stateOf(big.id)).toBe(before); // nothing persisted

    // Exclusive thresholds in SQL (proof I7): ₹10,000.01 with 1 step → UC012
    const edge = await makeDraft('asha', { lines: [{ amountMinor: 1_000_001 }] });
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), edge.id, { chain: [tierStep(1, ravi)] }),
    );
    // A forged tier copy or a level 2 that starts PENDING is not a chain either (proof I8)
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), edge.id, {
        chain: [tierStep(1, ravi), { ...tierStep(2, meera), tierCode: 'L1_MANAGER' }],
      }),
    );
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), edge.id, {
        chain: [tierStep(1, ravi), { ...tierStep(2, meera), appliesAboveMinor: 0 }],
      }),
    );
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), edge.id, {
        chain: [tierStep(1, ravi), { ...tierStep(2, meera), status: 'PENDING' }],
      }),
    );
    // A step for a claim that is already SUBMITTED, outside any submit (proof I9)
    const done = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    await submit('asha', done.id);
    const [sub] = await ownerSql<{ id: string }>`
      SELECT id FROM claim_submissions WHERE claim_id = ${done.id}`;
    await rejects(
      'UC012',
      () => appSql`
        INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label,
                                    applies_above_minor, approver_id, resolved_via, status)
        VALUES (${done.id}, ${sub!.id}, 2, 'L2_SKIP_LEVEL', 'Skip-level manager', 1000000,
                ${meera}, 'PRIMARY', 'WAITING')`,
    );
    // A claim pointed at ANOTHER claim's submission (proof I19)
    const other = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    await rejects('UC012', async () =>
      rawSubmit(await appClient(), other.id, {
        chain: [tierStep(1, ravi)],
        beforeClaimUpdate: (cn) =>
          cn.query(
            `UPDATE claims SET status = 'SUBMITTED', current_revision = 1,
                    current_submission_id = $2 WHERE id = $1`,
            [other.id, sub!.id],
          ),
      }),
    );

    // Positive control: the same helper with the full chain commits
    await rawSubmit(await appClient(), big.id, {
      chain: [tierStep(1, ravi), tierStep(2, meera), tierStep(3, vikram)],
    });
    await rawSubmit(await appClient(), edge.id, { chain: [tierStep(1, ravi), tierStep(2, meera)] });
    const statuses = await ownerSql<{ id: string; status: string }>`
      SELECT id, status FROM claims WHERE id IN (${big.id}, ${edge.id}) ORDER BY id`;
    expect(statuses.map((s) => s.status)).toEqual(['SUBMITTED', 'SUBMITTED']);
  });

  it('a forged snapshot that disagrees with the live lines is refused with UC016', async () => {
    const { ravi } = await ids();
    const c = await makeDraft('asha', {
      lines: [{ amountMinor: 700_000 }, { amountMinor: 100, category: 'LOCAL_TRANSPORT' }],
    });
    const before = await stateOf(c.id);
    const chain = [tierStep(1, ravi)];
    type Snap = Parameters<NonNullable<Parameters<typeof rawSubmit>[2]['snapshot']>>[0];
    const forgeries: [string, (s: Snap) => Snap][] = [
      [
        'same total, different lines',
        (s) => {
          s.lines[0]!.amountMinor += 1;
          s.lines[1]!.amountMinor -= 1;
          return s;
        },
      ],
      ['an extra line', (s) => ({ ...s, lines: [...s.lines, { ...s.lines[0]! }] })],
      ['a missing line', (s) => ({ ...s, lines: s.lines.slice(0, 1) })],
      [
        'another GL code',
        (s) => {
          s.lines[0]!.glCode = '9999';
          return s;
        },
      ],
      [
        'another category name',
        (s) => {
          s.lines[0]!.categoryName = 'Something else';
          return s;
        },
      ],
      [
        'another claimant name',
        (s) => {
          s.claimant.name = 'Someone Else';
          return s;
        },
      ],
      ['another title', (s) => ({ ...s, title: 'Different title' })],
      ['another total', (s) => ({ ...s, totalMinor: s.totalMinor + 1 })],
      [
        'a receipt that does not exist',
        (s) => {
          s.lines[0]!.receipts.push({
            receiptId: randomUUID(),
            fileName: 'x.pdf',
            contentType: 'application/pdf',
            sizeBytes: 1,
            sha256: 'b'.repeat(64),
            storageKey: 'receipts/other/evidence.pdf',
          });
          return s;
        },
      ],
    ];
    for (const [what, snapshot] of forgeries) {
      const err = await rejects('UC016', async () =>
        rawSubmit(await appClient(), c.id, { chain, snapshot }),
      );
      expect(String((err as Error).message), what).toMatch(/SNAPSHOT_MISMATCH/);
    }
    // A forged revision or submitter (proof I17)
    await rejects('UC016', async () => rawSubmit(await appClient(), c.id, { chain, revision: 2 }));
    await rejects('UC016', async () =>
      rawSubmit(await appClient(), c.id, { chain, submittedById: ravi }),
    );
    // The snapshot freeze (BUG-2): once the submission row exists, editing a line inside the
    // same transaction is refused (UC002), so the snapshot can't drift from what is submitted
    for (const edit of [
      `UPDATE line_items SET amount_minor = amount_minor + 1 WHERE claim_id = $1`,
      `DELETE FROM line_items WHERE claim_id = $1`,
      `INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
       SELECT $1, category_id, expense_date, 5, 'Sneaked in' FROM line_items WHERE claim_id = $1 LIMIT 1`,
    ])
      await rejects('UC002', async () =>
        rawSubmit(await appClient(), c.id, {
          chain,
          beforeClaimUpdate: (cn) => cn.query(edit, [c.id]),
        }),
      );
    // A retitle after the snapshot makes the submission disagree with the claim it submits
    await rejects('UC016', async () =>
      rawSubmit(await appClient(), c.id, {
        chain,
        beforeClaimUpdate: (cn) =>
          cn.query(`UPDATE claims SET title = 'Retitled after the snapshot' WHERE id = $1`, [c.id]),
      }),
    );
    expect(await stateOf(c.id)).toBe(before);

    // Positive control: the honest snapshot is accepted
    await rawSubmit(await appClient(), c.id, { chain });
    const [row] = await ownerSql`SELECT status, current_revision FROM claims WHERE id = ${c.id}`;
    expect(row).toEqual({ status: 'SUBMITTED', current_revision: 1 });
  });

  it('a raw invalid status transition raises UC005', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const before = await stateOf(c.id);
    // DRAFT → APPROVED / REJECTED, with or without the timestamps (proof I1), as app and owner
    for (const sql of [appSql, ownerSql]) {
      await rejects('UC005', () => sql`UPDATE claims SET status = 'APPROVED' WHERE id = ${c.id}`);
      await rejects(
        'UC005',
        () => sql`UPDATE claims SET status = 'APPROVED', approved_at = now() WHERE id = ${c.id}`,
      );
      await rejects('UC005', () => sql`UPDATE claims SET status = 'REJECTED' WHERE id = ${c.id}`);
    }
    // A claim is born an empty DRAFT at revision 0
    const { asha } = await ids();
    await rejects(
      'UC005',
      () =>
        appSql`INSERT INTO claims (claimant_id, title, status) VALUES (${asha}, 'Born submitted', 'SUBMITTED')`,
    );
    await rejects(
      'UC005',
      () =>
        appSql`INSERT INTO claims (claimant_id, title, current_revision) VALUES (${asha}, 'Born at r1', 1)`,
    );
    expect(await stateOf(c.id)).toBe(before);

    // Step gating: a WAITING step can't jump to APPROVED (proof I12)
    const big = await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] });
    await submit('asha', big.id);
    const [l2] = await ownerSql<{ id: string }>`
      SELECT id FROM approval_steps WHERE claim_id = ${big.id} AND level = 2`;
    await rejects(
      'UC005',
      () =>
        appSql`UPDATE approval_steps SET status = 'APPROVED', decided_at = now() WHERE id = ${l2!.id}`,
    );
    // SUBMITTED → DRAFT is legal only through recall; with open steps it is a broken chain (UC012),
    // and SUBMITTED → SUBMITTED via a raw pointer move is IMMUTABLE_FIELD (UC010)
    await rejects('UC012', () => appSql`UPDATE claims SET status = 'DRAFT' WHERE id = ${big.id}`);
    await rejects(
      'UC010',
      () => appSql`UPDATE claims SET current_revision = 2 WHERE id = ${big.id}`,
    );
  });

  it("vikram's ₹25,000 claim returns 422 ROUTING_UNRESOLVABLE and the claim is unchanged", async () => {
    const c = await makeDraft('vikram', { lines: [{ amountMinor: 2_500_000 }] });
    const before = await stateOf(c.id);

    const res = await submit('vikram', c.id);
    expect(await bodyOf(res)).toEqual({
      status: 422,
      error: expect.objectContaining({
        code: 'ROUTING_UNRESOLVABLE',
        details: { tierCode: 'L2_SKIP_LEVEL', level: 2 },
      }),
    });
    expect(await stateOf(c.id)).toBe(before); // still DRAFT, rev 0; no submission, step or event

    // The positive control on the same claim: at ₹8,000 it routes (to the fallback)
    await ownerSql`UPDATE line_items SET amount_minor = 800000 WHERE claim_id = ${c.id}`;
    expect((await submit('vikram', c.id)).status).toBe(200);
  });
});
