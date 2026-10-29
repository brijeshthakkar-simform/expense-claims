// TC-I11 (§3.4-a, §6-2, §7-Q2): an APPROVED claim is read-only, at every layer (02 §2, 03 §5).
// The service refuses with 409 CLAIM_LOCKED from decide(); if it were bypassed, the database
// refuses too (claims_guard and the child triggers raise UC001), and that SQLSTATE still maps to
// the same 409 CLAIM_LOCKED. While SUBMITTED the content is frozen instead (409
// CLAIM_NOT_EDITABLE, hint RECALL_TO_EDIT). Receipt upload and delete are mutations too (P6).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as uploadRoute from '@/app/api/v1/claims/[claimId]/line-items/[lineItemId]/receipts/route';
import * as receiptRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/route';
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import { getDb } from '@/server/db/client';
import { readSqlState } from '@/server/db/pg-error';
import { mapError } from '@/server/errors/map-error';
import { todayInBusinessTz } from '@/shared/dates';
import type { ClaimDetail } from '@/shared/dto/claims';
import { asPersona } from '../../helpers/auth';
import { appClient, appSql, errorOf as dbErrorOf, ownerSql, rejects } from '../../helpers/db';
import {
  approveAs,
  categoryIds,
  fakePdf,
  lineInput,
  makeDraft,
  memoryStorage,
  pdfForm,
  submitAs,
} from '../../helpers/factories';
import { callRoute, errorOf, type Method, type RouteModule } from '../../helpers/http';
import { rawSubmit, tierStep } from '../../helpers/raw-submit';

/**
 * C04's shape: ₹75,000 over two lines → [ravi, meera, vikram], all three approve → APPROVED. The
 * conference pass carries a receipt (P6), so there is evidence to try to remove.
 */
async function approvedClaim(): Promise<ClaimDetail> {
  let c = await submitAs(
    'asha',
    await makeDraft('asha', {
      title: 'Annual tech conference',
      lines: [
        {
          amountMinor: 4_500_000,
          category: 'TRAINING',
          description: 'Conference pass',
          receipt: fakePdf(2_048, 'conference-pass.pdf'),
        },
        { amountMinor: 3_000_000, category: 'LODGING', description: 'Hotel, three nights' },
      ],
    }),
  );
  for (const who of ['ravi', 'meera', 'vikram'] as const) c = await approveAs(who, c);
  expect(c).toMatchObject({ status: 'APPROVED', totalMinor: 7_500_000 });
  return c;
}

/** The claim's whole footprint as text: a refusal must leave it byte-identical (incl. updated_at). */
const footprint = async (claimId: string) =>
  (
    await ownerSql<{ s: string }>`SELECT json_build_object(
      'claim', (SELECT row_to_json(c) FROM claims c WHERE c.id = ${claimId}),
      'lines', (SELECT json_agg(l ORDER BY l.id) FROM line_items l WHERE l.claim_id = ${claimId}),
      'receipts', (SELECT json_agg(r ORDER BY r.id) FROM receipts r WHERE r.claim_id = ${claimId}),
      'submissions', (SELECT json_agg(s ORDER BY s.revision) FROM claim_submissions s
                       WHERE s.claim_id = ${claimId}),
      'steps', (SELECT json_agg(st ORDER BY st.level) FROM approval_steps st
                 WHERE st.claim_id = ${claimId}),
      'events', (SELECT count(*) FROM claim_events e WHERE e.claim_id = ${claimId}))::text AS s`
  )[0]!.s;

interface Mutation {
  name: string;
  mod: RouteModule;
  method: Method;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}

/** Every owner mutation route on the claim, each with a body that would succeed on a DRAFT. */
const mutations = (c: ClaimDetail): Mutation[] => {
  const line = c.lineItems.find((l) => l.receipts.length > 0)!;
  const receiptId = line.receipts[0]!.id;
  return [
    {
      name: 'PUT',
      mod: claimRoute,
      method: 'PUT',
      path: `/api/v1/claims/${c.id}`,
      body: {
        title: 'Annual tech conference (edited)',
        lineItems: c.lineItems.map((l) => ({ ...lineInput(l), amountMinor: 100 })),
      },
    },
    { name: 'DELETE', mod: claimRoute, method: 'DELETE', path: `/api/v1/claims/${c.id}` },
    { name: 'submit', mod: submitRoute, method: 'POST', path: `/api/v1/claims/${c.id}/submit` },
    {
      name: 'recall',
      mod: recallRoute,
      method: 'POST',
      path: `/api/v1/claims/${c.id}/recall`,
      body: { note: 'One more receipt' },
    },
    {
      name: 'receipt upload',
      mod: uploadRoute,
      method: 'POST',
      path: `/api/v1/claims/${c.id}/line-items/${line.id}/receipts`,
      params: { claimId: c.id, lineItemId: line.id },
      body: pdfForm(fakePdf(1_024, 'late-receipt.pdf')),
    },
    {
      name: 'receipt delete',
      mod: receiptRoute,
      method: 'DELETE',
      path: `/api/v1/claims/${c.id}/receipts/${receiptId}`,
      params: { claimId: c.id, receiptId },
    },
  ];
};

describe('TC-I11 an approved claim is locked', () => {
  it('every mutation route on an APPROVED claim returns 409 CLAIM_LOCKED', async () => {
    const c = await approvedClaim();
    expect(c.allowedActions).toEqual([]); // the UI offers the owner nothing
    const before = await footprint(c.id);
    const objects = memoryStorage().keys();
    expect(objects).toHaveLength(1);

    const tried: string[] = [];
    for (const m of mutations(c)) {
      tried.push(m.name);
      const res = await callRoute(m.mod, m.method, {
        path: m.path,
        params: m.params ?? { claimId: c.id },
        body: m.body,
        as: 'asha',
      });
      const { error } = await errorOf(res);
      expect([m.name, res.status, error.code, error.details]).toEqual([
        m.name,
        409,
        'CLAIM_LOCKED',
        { status: 'APPROVED' },
      ]);
      expect(error.requestId).toBe(res.headers.get('x-request-id'));
    }
    expect(tried).toEqual([
      'PUT',
      'DELETE',
      'submit',
      'recall',
      'receipt upload',
      'receipt delete',
    ]);
    expect(await footprint(c.id)).toBe(before); // nothing changed: not a line, not a timestamp
    expect(memoryStorage().keys()).toEqual(objects); // nor an object

    // The owner still reads it, read-only, with its approval chain intact
    const get = await callRoute(claimRoute, 'GET', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
    });
    const { data } = (await get.json()) as { data: ClaimDetail };
    expect(data).toMatchObject({ status: 'APPROVED', allowedActions: [] });
    expect(data.approval?.steps.map((s) => s.status)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
  });

  it('PUT on a SUBMITTED claim returns 409 CLAIM_NOT_EDITABLE with hint RECALL_TO_EDIT', async () => {
    const c = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] }),
    );
    expect(c.allowedActions).toEqual(['RECALL']); // the UI offers "Recall to edit", not Edit
    const before = await footprint(c.id);

    const res = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      body: {
        title: c.title,
        lineItems: c.lineItems.map((l) => ({ ...lineInput(l), amountMinor: 4_500_000 })),
      },
      as: 'asha',
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toMatchObject({
      code: 'CLAIM_NOT_EDITABLE',
      details: { hint: 'RECALL_TO_EDIT' },
    });
    expect(await footprint(c.id)).toBe(before);

    // A title-only change is content too, and so is an added line
    for (const body of [
      { title: 'Renamed in approval', lineItems: c.lineItems.map(lineInput) },
      {
        title: c.title,
        lineItems: [
          ...c.lineItems.map(lineInput),
          {
            expenseDate: todayInBusinessTz(),
            categoryId: (await categoryIds()).MEALS!,
            amountMinor: 100,
            description: 'Sneaked in',
          },
        ],
      },
    ]) {
      const r = await callRoute(claimRoute, 'PUT', {
        path: `/api/v1/claims/${c.id}`,
        params: { claimId: c.id },
        body,
        as: 'asha',
      });
      expect([r.status, (await errorOf(r)).error.code]).toEqual([409, 'CLAIM_NOT_EDITABLE']);
    }
    expect(await footprint(c.id)).toBe(before);
  });

  it('raw SQL as expense_app on an APPROVED claim raises UC001', async () => {
    const c = await approvedClaim();
    const [line] = c.lineItems;
    const cats = await categoryIds();
    const before = await footprint(c.id);

    // Lines: UPDATE, INSERT, DELETE (line_items_before_write → assert_claim_editable)
    await rejects(
      'UC001',
      () => appSql`UPDATE line_items SET amount_minor = 100 WHERE id = ${line!.id}`,
    );
    await rejects(
      'UC001',
      () => appSql`UPDATE line_items SET description = 'Edited after approval'
                    WHERE claim_id = ${c.id}`,
    );
    await rejects(
      'UC001',
      () => appSql`
        INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
        VALUES (${c.id}, ${cats.MEALS}, ${todayInBusinessTz()}, 100, 'Added after approval')`,
    );
    await rejects('UC001', () => appSql`DELETE FROM line_items WHERE id = ${line!.id}`);
    await rejects('UC001', () => appSql`DELETE FROM line_items WHERE claim_id = ${c.id}`);

    // The claim row: status, title, approved_at (rule 5 runs before the UC010 timestamp rule)
    await rejects('UC001', () => appSql`UPDATE claims SET status = 'DRAFT' WHERE id = ${c.id}`);
    await rejects('UC001', () => appSql`UPDATE claims SET status = 'SUBMITTED' WHERE id = ${c.id}`);
    await rejects(
      'UC001',
      () => appSql`UPDATE claims SET title = 'Renamed after approval' WHERE id = ${c.id}`,
    );
    await rejects(
      'UC001',
      () => appSql`UPDATE claims SET approved_at = approved_at - interval '30 days'
                    WHERE id = ${c.id}`,
    );
    await rejects('UC001', () => appSql`DELETE FROM claims WHERE id = ${c.id}`);

    // A forged resubmission (the submission trigger checks editability too)
    const ravi = await asPersona('ravi');
    await rejects('UC001', async () =>
      rawSubmit(await appClient(), c.id, { chain: [tierStep(1, ravi.id)] }),
    );
    // "Any role": the owner hits the same wall
    await rejects(
      'UC001',
      () => ownerSql`UPDATE claims SET title = 'Owner edit' WHERE id = ${c.id}`,
    );
    await rejects(
      'UC001',
      () => ownerSql`UPDATE line_items SET amount_minor = 1 WHERE id = ${line!.id}`,
    );

    expect(await footprint(c.id)).toBe(before);
    expect(await ownerSql`SELECT status::text, total_minor FROM claims WHERE id = ${c.id}`).toEqual(
      [{ status: 'APPROVED', total_minor: 7_500_000 }],
    );
  });

  it('Prisma lineItem.update on an APPROVED claim maps to 409 CLAIM_LOCKED', async () => {
    const c = await approvedClaim();
    const line = c.lineItems[0]!;
    const before = await footprint(c.id);

    // A model operation, as a repository would send it if a service forgot its check
    const err = await dbErrorOf(() =>
      getDb().lineItem.update({ where: { id: line.id }, data: { amountMinor: 1 } }),
    );
    expect(err).toMatchObject({ name: 'PrismaClientKnownRequestError', code: 'P2039' });
    expect(readSqlState(err)).toBe('UC001');
    const mapped = mapError(err);
    expect([mapped.status, mapped.code, mapped.details]).toEqual([
      409,
      'CLAIM_LOCKED',
      { status: 'APPROVED' },
    ]);

    // The same for the claim row, and inside an interactive transaction
    const viaClaim = mapError(
      await dbErrorOf(() =>
        getDb().claim.update({ where: { id: c.id }, data: { title: 'Prisma edit' } }),
      ),
    );
    expect([viaClaim.status, viaClaim.code]).toEqual([409, 'CLAIM_LOCKED']);
    const viaTx = mapError(
      await dbErrorOf(() =>
        getDb().$transaction(async (tx) => tx.lineItem.deleteMany({ where: { claimId: c.id } })),
      ),
    );
    expect([viaTx.status, viaTx.code]).toEqual([409, 'CLAIM_LOCKED']);

    expect(await footprint(c.id)).toBe(before);
    // and an unknown id is not a lock: nothing to update is Prisma's own not-found, not a 409
    expect(
      readSqlState(
        await dbErrorOf(() =>
          getDb().lineItem.update({ where: { id: randomUUID() }, data: { amountMinor: 1 } }),
        ),
      ),
    ).toBeUndefined();
  });
});
