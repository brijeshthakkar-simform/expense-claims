// TC-I22 (§3.3-a/b, §7-Q3, RT-M4): rejection and resubmission (02 §7). A rejected claim shows the
// claimant why, who and when, and is editable again; resubmitting it creates revision N+1 with a
// brand-new chain, while everything about revision N (snapshot, steps, reason, events) stays
// exactly as it was, including the receipts it froze (P6, RT-M4).
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as historyRoute from '@/app/api/v1/claims/[claimId]/history/route';
import * as receiptContentRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/content/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import type { ClaimDetail } from '@/shared/dto/claims';
import { ClaimHistory } from '@/shared/dto/history';
import { asPersona, type Persona } from '../../helpers/auth';
import { ownerSql } from '../../helpers/db';
import {
  approveAs,
  categoryIds,
  fakePdf,
  lineInput,
  makeDraft,
  memoryStorage,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const C05_REASON = 'Hotel invoice missing for 3 Oct';
const C06_REASON = 'Business fare is outside the travel policy; claim the train fare instead';

const get = async (as: Persona, id: string) => {
  const res = await callRoute(claimRoute, 'GET', {
    path: `/api/v1/claims/${id}`,
    params: { claimId: id },
    as,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ClaimDetail }).data;
};
const put = (as: Persona, id: string, body: unknown) =>
  callRoute(claimRoute, 'PUT', { path: `/api/v1/claims/${id}`, params: { claimId: id }, body, as });
const resubmit = (as: Persona, id: string) =>
  callRoute(submitRoute, 'POST', {
    path: `/api/v1/claims/${id}/submit`,
    params: { claimId: id },
    as,
  });
const historyOf = async (as: Persona, id: string) => {
  const res = await callRoute(historyRoute, 'GET', {
    path: `/api/v1/claims/${id}/history`,
    params: { claimId: id },
    as,
  });
  expect(res.status).toBe(200);
  return ClaimHistory.parse(((await res.json()) as { data: unknown }).data); // the C-10 contract
};

/** C05's shape: Asha ₹12,000 (lodging + meals) → [ravi, meera]; Ravi rejects level 1. */
async function rejectedC05(): Promise<ClaimDetail> {
  const draft = await makeDraft('asha', {
    title: 'Hyderabad site visit',
    lines: [
      {
        amountMinor: 900_000,
        category: 'LODGING',
        expenseDate: '2026-10-03',
        description: 'Hotel',
      },
      { amountMinor: 300_000, category: 'MEALS', expenseDate: '2026-10-03', description: 'Meals' },
    ],
  });
  return rejectAs('ravi', await submitAs('asha', draft), C05_REASON);
}

/** Revision 1 exactly as the DB holds it, as text: the submission row and its steps. */
const revisionRows = async (claimId: string, revision: number) =>
  (
    await ownerSql<{ s: string }>`
      SELECT json_build_object(
        'submission', row_to_json(sub),
        'steps', (SELECT json_agg(st ORDER BY st.level) FROM approval_steps st
                   WHERE st.submission_id = sub.id))::text AS s
        FROM claim_submissions sub
       WHERE sub.claim_id = ${claimId} AND sub.revision = ${revision}`
  )[0]!.s;

describe('TC-I22 rejection and resubmission', () => {
  it('a rejected claim shows reason, approver and time to the claimant and is editable', async () => {
    const ravi = await asPersona('ravi');
    const c = await rejectedC05();
    const [step] = await ownerSql<{ decided_at: Date }>`
      SELECT decided_at FROM approval_steps WHERE claim_id = ${c.id} AND level = 1`;

    const detail = await get('asha', c.id);
    expect(detail).toMatchObject({
      status: 'REJECTED',
      currentRevision: 1,
      allowedActions: ['EDIT', 'SUBMIT'], // editable and resubmittable; not deletable
      lastRejection: {
        revision: 1,
        level: 1,
        reason: C05_REASON,
        by: { id: ravi.id, name: 'Ravi Menon' },
        at: step!.decided_at.toISOString(),
      },
    });
    expect(detail.rejectedAt).toBe(step!.decided_at.toISOString()); // one instant, one transaction
    expect(
      detail.approval?.steps.map((s) => [s.approver.name, s.status, s.rejectionReason]),
    ).toEqual([
      ['Ravi Menon', 'REJECTED', C05_REASON],
      ['Meera Iyer', 'CANCELLED', null],
    ]);

    // Editable through the same PUT as a draft; the banner's data survives the edit
    const res = await put('asha', c.id, {
      title: 'Hyderabad site visit (with invoice)',
      lineItems: detail.lineItems.map(lineInput),
    });
    expect(res.status).toBe(200);
    const edited = ((await res.json()) as { data: ClaimDetail }).data;
    expect(edited).toMatchObject({
      status: 'REJECTED',
      title: 'Hyderabad site visit (with invoice)',
      lastRejection: { revision: 1, level: 1, reason: C05_REASON },
      allowedActions: ['EDIT', 'SUBMIT'],
    });
    // The rejecting approver keeps read access and sees the same reason; Meera never acted
    expect((await get('ravi', c.id)).lastRejection).toEqual(detail.lastRejection);
    const meera = await callRoute(claimRoute, 'GET', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'meera',
    });
    expect([meera.status, (await errorOf(meera)).error.code]).toEqual([404, 'CLAIM_NOT_FOUND']);
  });

  it('after edit and resubmit, revision 1 snapshot, steps and reason are unchanged', async () => {
    const c = await rejectedC05();
    const before = await revisionRows(c.id, 1);
    const historyBefore = (await historyOf('asha', c.id)).submissions[0]!;
    expect(historyBefore.snapshot.lines.map((l) => l.amountMinor).sort((a, b) => a - b)).toEqual([
      300_000, 900_000,
    ]);

    // Edit: change the hotel amount, drop the meals line, add a new one; then resubmit
    const cats = await categoryIds();
    const hotel = c.lineItems.find((l) => l.description === 'Hotel')!;
    const res = await put('asha', c.id, {
      title: c.title,
      lineItems: [
        { ...lineInput(hotel), amountMinor: 850_000 },
        {
          expenseDate: '2026-10-04',
          categoryId: cats.LOCAL_TRANSPORT!,
          amountMinor: 120_000,
          description: 'Airport cab',
        },
      ],
    });
    expect(res.status).toBe(200);
    const r2 = await resubmit('asha', c.id);
    expect(r2.status).toBe(200);
    const after = ((await r2.json()) as { data: ClaimDetail }).data;
    expect(after).toMatchObject({ status: 'SUBMITTED', currentRevision: 2, totalMinor: 970_000 });

    // Revision 1: byte-identical rows, and the same snapshot through the API
    expect(await revisionRows(c.id, 1)).toBe(before);
    const h = await historyOf('asha', c.id);
    expect(h.submissions.map((s) => s.revision)).toEqual([1, 2]);
    expect(h.submissions[0]).toEqual(historyBefore);
    expect(h.submissions[0]!.steps.map((s) => [s.status, s.rejectionReason])).toEqual([
      ['REJECTED', C05_REASON],
      ['CANCELLED', null],
    ]);
    expect(h.submissions[0]).toMatchObject({ outcome: 'REJECTED', totalMinor: 1_200_000 });
    // Revision 2 froze the edited content
    expect(h.submissions[1]).toMatchObject({
      outcome: 'IN_APPROVAL',
      totalMinor: 970_000,
      lineItemCount: 2,
    });
    expect(h.submissions[1]!.snapshot.lines.map((l) => [l.lineItemId, l.amountMinor])).toEqual(
      expect.arrayContaining([[hotel.id, 850_000]]), // the kept line keeps its id across revisions
    );
    // The reason also lives in the append-only event
    const [event] = await ownerSql<{ reason: string }>`
      SELECT reason FROM claim_events WHERE claim_id = ${c.id} AND type = 'CLAIM_REJECTED'`;
    expect(event!.reason).toBe(C05_REASON);
  });

  it('events read CLAIM_SUBMITTED(r1) → CLAIM_REJECTED(r1) → CLAIM_RESUBMITTED(r2)', async () => {
    const asha = await asPersona('asha');
    const ravi = await asPersona('ravi');
    const c = await rejectedC05();
    const detail = await get('asha', c.id);
    await put('asha', c.id, { title: c.title, lineItems: detail.lineItems.map(lineInput) });
    const res = await resubmit('asha', c.id);
    expect(res.status).toBe(200);

    const { events } = await historyOf('asha', c.id);
    expect(events.map((e) => `${e.type}(r${e.revision})`)).toEqual([
      'CLAIM_SUBMITTED(r1)',
      'CLAIM_REJECTED(r1)',
      'CLAIM_RESUBMITTED(r2)',
    ]);
    expect(
      events.map((e) => [e.actor.id, e.actorRole, `${e.fromStatus}→${e.toStatus}`, e.reason]),
    ).toEqual([
      [asha.id, 'CLAIMANT', 'DRAFT→SUBMITTED', null],
      [ravi.id, 'APPROVER', 'SUBMITTED→REJECTED', C05_REASON],
      [asha.id, 'CLAIMANT', 'REJECTED→SUBMITTED', null],
    ]);
    // The resubmission points back at the rejected revision and carries its new chain
    expect(events[2]!.payload).toEqual({
      lineItemCount: 2,
      chain: [
        { level: 1, tierCode: 'L1_MANAGER', approverId: ravi.id, resolvedVia: 'PRIMARY' },
        {
          level: 2,
          tierCode: 'L2_SKIP_LEVEL',
          approverId: (await asPersona('meera')).id,
          resolvedVia: 'PRIMARY',
        },
      ],
      previousRevision: { revision: 1, totalMinor: 1_200_000, outcome: 'REJECTED' },
    });
    expect(events[2]!.requestId).toBe(res.headers.get('x-request-id'));
    // Oldest first, by (occurred_at, id), exactly as the table orders them
    const rows = await ownerSql<{ id: string }>`
      SELECT id FROM claim_events WHERE claim_id = ${c.id} ORDER BY occurred_at, id`;
    expect(events.map((e) => e.id)).toEqual(rows.map((r) => r.id));
  });

  it('preserved vs reset: claim number, events, reasons and prior steps preserved; status, chain and editability reset', async () => {
    const meera = await asPersona('meera');
    // C06's story: rev 1 ₹30,000 → [ravi, meera]; Ravi approves; Meera rejects at L2
    const draft = await makeDraft('asha', {
      title: 'Mumbai client visit',
      lines: [
        { amountMinor: 2_200_000, category: 'TRAVEL_AIR', description: 'Flight' },
        { amountMinor: 800_000, category: 'LODGING', description: 'Hotel' },
      ],
    });
    const r1 = await rejectAs(
      'meera',
      await approveAs('ravi', await submitAs('asha', draft)),
      C06_REASON,
    );
    const claimBefore = (
      await ownerSql`SELECT id, claim_number, claimant_id, created_at, currency, submitted_at,
                            rejected_at FROM claims WHERE id = ${r1.id}`
    )[0]!;
    const eventsBefore = await ownerSql`
      SELECT row_to_json(e)::text AS e FROM claim_events e WHERE claim_id = ${r1.id}
       ORDER BY occurred_at, id`;
    const rev1Before = await revisionRows(r1.id, 1);

    // Asha edits it down to ₹9,500 (the hotel line keeps its id) and resubmits
    const cats = await categoryIds();
    const hotel = r1.lineItems.find((l) => l.description === 'Hotel')!;
    await put('asha', r1.id, {
      title: r1.title,
      lineItems: [
        { ...lineInput(hotel), amountMinor: 600_000 },
        {
          expenseDate: hotel.expenseDate,
          categoryId: cats.TRAVEL_RAIL!,
          amountMinor: 350_000,
          description: 'Train',
        },
      ],
    });
    const res = await resubmit('asha', r1.id);
    expect(res.status).toBe(200);
    const r2 = ((await res.json()) as { data: ClaimDetail }).data;

    // Preserved: identity, every earlier event, revision 1's steps and the rejection reason
    const claimAfter = (
      await ownerSql`SELECT id, claim_number, claimant_id, created_at, currency, submitted_at,
                            rejected_at FROM claims WHERE id = ${r1.id}`
    )[0]!;
    expect(claimAfter).toMatchObject({
      id: claimBefore.id,
      claim_number: claimBefore.claim_number,
      claimant_id: claimBefore.claimant_id,
      created_at: claimBefore.created_at,
      currency: claimBefore.currency,
    });
    expect(r2.claimNumber).toBe(r1.claimNumber);
    expect(
      (
        await ownerSql`
          SELECT row_to_json(e)::text AS e FROM claim_events e WHERE claim_id = ${r1.id}
           ORDER BY occurred_at, id`
      ).slice(0, eventsBefore.length),
    ).toEqual(eventsBefore);
    expect(await revisionRows(r1.id, 1)).toBe(rev1Before);
    expect(r2.lastRejection).toMatchObject({
      revision: 1,
      level: 2,
      reason: C06_REASON,
      by: { id: meera.id, name: 'Meera Iyer' },
    }); // still there as "previously rejected" context
    expect(r2.lineItems.map((l) => l.id)).toContain(hotel.id);

    // Reset: status, timestamps, revision and a brand-new chain from the new total (2 → 1 step);
    // Ravi's revision-1 approval does not carry over
    expect(r2).toMatchObject({ status: 'SUBMITTED', currentRevision: 2, totalMinor: 950_000 });
    expect(claimAfter.rejected_at).toBeNull();
    expect(claimAfter.submitted_at.getTime()).toBeGreaterThan(claimBefore.submitted_at.getTime());
    expect(r2.approval).toMatchObject({ revision: 2 });
    expect(r2.approval!.steps.map((s) => [s.approver.name, s.status, s.decidedAt])).toEqual([
      ['Ravi Menon', 'PENDING', null],
    ]);
    // Editability reset: frozen again until the next recall or rejection
    expect(r2.allowedActions).toEqual(['RECALL']);
    const frozen = await put('asha', r1.id, {
      title: 'Again',
      lineItems: r2.lineItems.map(lineInput),
    });
    expect([frozen.status, (await errorOf(frozen)).error.code]).toEqual([
      409,
      'CLAIM_NOT_EDITABLE',
    ]);
    // Ravi must sign again, on the new content: a tab still showing revision 1 is refused
    const stale = await callRoute(approveRoute, 'POST', {
      path: `/api/v1/claims/${r1.id}/approve`,
      params: { claimId: r1.id },
      body: { revision: 1 },
      as: 'ravi',
    });
    expect([stale.status, (await errorOf(stale)).error]).toEqual([
      409,
      expect.objectContaining({
        code: 'REVISION_MISMATCH',
        details: { requestedRevision: 1, currentRevision: 2 },
      }),
    ]);
    // Meera rejected revision 1 but has no step on revision 2: still visible (REJECTED step),
    // read-only, and not in her queue
    expect((await get('meera', r1.id)).allowedActions).toEqual([]);
  });

  it('receipts referenced by revision 1 stay downloadable after the line is deleted', async () => {
    const hotelPdf = fakePdf(5_000, 'hotel-invoice.pdf');
    const mealsPdf = fakePdf(3_000, 'meals.pdf');
    const sha = async (b: Blob) =>
      createHash('sha256')
        .update(new Uint8Array(await b.arrayBuffer()))
        .digest('hex');
    // C05's shape with a receipt on each line. Submitting it at all proves #6 v2: v1 of
    // claim_submissions_verify refused any snapshot with receipts (UC016)
    const draft = await makeDraft('asha', {
      title: 'Hyderabad site visit',
      lines: [
        {
          amountMinor: 900_000,
          category: 'LODGING',
          expenseDate: '2026-10-03',
          description: 'Hotel',
          receipt: hotelPdf,
        },
        {
          amountMinor: 300_000,
          category: 'MEALS',
          expenseDate: '2026-10-03',
          description: 'Meals',
          receipt: mealsPdf,
        },
      ],
    });
    const r1 = await rejectAs('ravi', await submitAs('asha', draft), C05_REASON);
    const hotel = r1.lineItems.find((l) => l.description === 'Hotel')!;
    const meals = r1.lineItems.find((l) => l.description === 'Meals')!;
    const hotelReceipt = hotel.receipts[0]!;
    const [hotelRow] = await ownerSql<{ storage_key: string; sha256: string }>`
      SELECT storage_key, sha256 FROM receipts WHERE id = ${hotelReceipt.id}`;
    const rev1Before = await revisionRows(r1.id, 1);

    // Asha drops the hotel line (and with it its receipt row) and resubmits
    const put = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${r1.id}`,
      params: { claimId: r1.id },
      body: { title: r1.title, lineItems: [lineInput(meals)] },
      as: 'asha',
    });
    expect(put.status).toBe(200);
    expect(await ownerSql`SELECT id FROM receipts WHERE id = ${hotelReceipt.id}`).toEqual([]);
    // D-31: the claim was submitted before, so the object stays (a snapshot references it)
    expect(memoryStorage().has(hotelRow!.storage_key)).toBe(true);
    const res = await resubmit('asha', r1.id);
    expect(res.status).toBe(200);
    const r2 = ((await res.json()) as { data: ClaimDetail }).data;
    expect(r2).toMatchObject({ currentRevision: 2, totalMinor: 300_000 });
    expect(r2.lineItems.flatMap((l) => l.receipts.map((r) => r.fileName))).toEqual(['meals.pdf']);

    // Revision 1 still names the hotel receipt with its key and hash, untouched; revision 2 doesn't
    expect(await revisionRows(r1.id, 1)).toBe(rev1Before);
    const history = await historyOf('asha', r1.id);
    const receiptsOf = (rev: number) =>
      history.submissions[rev - 1]!.snapshot.lines.flatMap((l) => l.receipts);
    expect(receiptsOf(1)).toContainEqual({
      receiptId: hotelReceipt.id,
      fileName: 'hotel-invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5_000,
      sha256: hotelRow!.sha256,
      storageKey: hotelRow!.storage_key,
    });
    expect(receiptsOf(2).map((r) => r.fileName)).toEqual(['meals.pdf']);

    // The revision-1 evidence downloads, byte-identical, for everyone who can see the claim:
    // the claimant, the approver who rejected revision 1 (and holds revision 2) and finance
    const download = (as: Persona, receiptId = hotelReceipt.id) =>
      callRoute(receiptContentRoute, 'GET', {
        path: `/api/v1/claims/${r1.id}/receipts/${receiptId}/content`,
        params: { claimId: r1.id, receiptId },
        as,
      });
    for (const as of ['asha', 'ravi', 'farah'] as const) {
      const got = await download(as);
      expect([as, got.status]).toEqual([as, 200]);
      expect(got.headers.get('content-disposition')).toContain('filename="hotel-invoice.pdf"');
      expect(got.headers.get('content-type')).toBe('application/pdf');
      expect(await sha(await got.blob())).toBe(hotelRow!.sha256);
    }
    expect(await sha(hotelPdf)).toBe(hotelRow!.sha256);
    // … but only through its own claim, and not for someone outside it
    const outsider = await download('neha');
    expect([outsider.status, (await errorOf(outsider)).error.code]).toEqual([
      404,
      'CLAIM_NOT_FOUND',
    ]);
    const unknown = await download('asha', randomUUID());
    expect([unknown.status, (await errorOf(unknown)).error.code]).toEqual([
      404,
      'RECEIPT_NOT_FOUND',
    ]);
    // The live receipt downloads as before
    expect((await download('asha', meals.receipts[0]!.id)).status).toBe(200);
  });
});
