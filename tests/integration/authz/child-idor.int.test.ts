// TC-I14 (RT-B2, §3.1-b): a child id from another claim, riding inside a request on MY claim, is
// refused before anything is written (04 §5.2): a line id in a PUT (P2), and a line or receipt id
// in the receipt routes (P6), which resolve the child only within the claim at the path.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import * as uploadRoute from '@/app/api/v1/claims/[claimId]/line-items/[lineItemId]/receipts/route';
import * as contentRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/content/route';
import * as receiptRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import { todayInBusinessTz } from '@/shared/dates';
import { ownerSql } from '../../helpers/db';
import {
  categoryIds,
  fakePdf,
  lineInput,
  makeDraft,
  memoryStorage,
  pdfForm,
  submitAs,
  type ClaimDetail,
} from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

let mine: ClaimDetail; // Asha's draft: the claim in the URL
let myOther: ClaimDetail; // another of Asha's own drafts
let victim: ClaimDetail; // Neha's draft: the claim whose line id is smuggled in

beforeEach(async () => {
  mine = await makeDraft('asha', {
    title: 'My trip',
    lines: [
      { amountMinor: 1_000, description: 'Mine A' },
      { amountMinor: 2_000, description: 'Mine B' },
    ],
  });
  myOther = await makeDraft('asha', { title: 'My other trip', lines: [{ amountMinor: 3_000 }] });
  victim = await makeDraft('neha', {
    title: 'Neha offsite',
    lines: [{ amountMinor: 50_000, description: 'Neha hotel' }, { amountMinor: 7_000 }],
  });
});

/** The claim row plus its lines, as text: byte-for-byte, including updated_at. */
const snapshot = async (id: string) =>
  (
    await ownerSql<{ s: string }>`SELECT json_build_object(
      'claim', (SELECT row_to_json(c) FROM claims c WHERE c.id = ${id}),
      'lines', (SELECT json_agg(l ORDER BY l.id) FROM line_items l WHERE l.claim_id = ${id}))::text AS s`
  )[0]!.s;

const putMine = (lineItems: unknown[]) =>
  callRoute(claimRoute, 'PUT', {
    path: `/api/v1/claims/${mine.id}`,
    params: { claimId: mine.id },
    as: 'asha',
    body: { title: 'Renamed by the attack', lineItems },
  });

/** Every way a foreign line id can ride in a PUT on my claim. */
async function attacks(foreign: ClaimDetail['lineItems'][number]) {
  const cats = await categoryIds();
  const fresh = {
    expenseDate: todayInBusinessTz(),
    categoryId: cats.MEALS,
    amountMinor: 1,
    description: 'New line',
  };
  return {
    'foreign line, unchanged': [lineInput(mine.lineItems[0]!), lineInput(foreign)],
    'foreign line, amount zeroed to 1': [
      lineInput(mine.lineItems[0]!),
      { ...lineInput(foreign), amountMinor: 1 },
    ],
    'foreign line among deletes and inserts': [
      { ...lineInput(foreign), description: 'Pwned' },
      fresh,
    ],
    'foreign line only': [{ ...lineInput(foreign), amountMinor: 99_999 }],
  };
}

it("PUT on my claim containing another claim's line id returns 404 LINE_ITEM_NOT_FOUND and changes nothing", async () => {
  const before = await Promise.all([mine, myOther, victim].map((c) => snapshot(c.id)));
  // another employee's line, and a line of another claim of my own: both are foreign to THIS claim
  for (const foreign of [victim.lineItems[0]!, myOther.lineItems[0]!])
    for (const [name, lineItems] of Object.entries(await attacks(foreign))) {
      const res = await putMine(lineItems);
      const { error } = await errorOf(res);
      expect([name, res.status, error.code]).toEqual([name, 404, 'LINE_ITEM_NOT_FOUND']);
      expect(JSON.stringify(error)).not.toContain(foreign.description); // nothing about it leaks
    }
  // changes nothing: not the attacker's own claim (no title change, no deletes, no inserts) …
  expect(await Promise.all([mine, myOther, victim].map((c) => snapshot(c.id)))).toEqual(before);
  // … and the same PUT without the smuggled id goes through (positive control)
  const ok = await putMine([lineInput(mine.lineItems[0]!)]);
  expect(ok.status).toBe(200);
  expect((await ownerSql`SELECT total_minor FROM claims WHERE id = ${mine.id}`)[0]).toEqual({
    total_minor: 1_000,
  });
});

it("the victim's rows and total are byte-for-byte unchanged", async () => {
  const victimBefore = await snapshot(victim.id);
  for (const foreign of victim.lineItems)
    for (const lineItems of Object.values(await attacks(foreign))) {
      const res = await putMine(lineItems);
      expect(res.status).toBe(404);
    }
  // Neha's own PUT through Asha's claim id doesn't work either: the claim lock is owner-scoped
  const viaVictim = await callRoute(claimRoute, 'PUT', {
    path: `/api/v1/claims/${mine.id}`,
    params: { claimId: mine.id },
    as: 'neha',
    body: { title: 'x'.repeat(5), lineItems: victim.lineItems.map(lineInput) },
  });
  expect([viaVictim.status, (await errorOf(viaVictim)).error.code]).toEqual([
    404,
    'CLAIM_NOT_FOUND',
  ]);

  expect(await snapshot(victim.id)).toBe(victimBefore); // row_to_json text: every column, incl. updated_at
  const [row] = await ownerSql<{ total_minor: number; n: number }>`
    SELECT c.total_minor, (SELECT count(*)::int FROM line_items l WHERE l.claim_id = c.id) AS n
      FROM claims c WHERE c.id = ${victim.id}`;
  expect(row).toEqual({ total_minor: 57_000, n: 2 });
});

// ---------------------------------------------------------------------------------- receipts

const uploadTo = (claimId: string, lineItemId: string, as: 'asha' | 'neha' = 'asha') =>
  callRoute(uploadRoute, 'POST', {
    path: `/api/v1/claims/${claimId}/line-items/${lineItemId}/receipts`,
    params: { claimId, lineItemId },
    body: pdfForm(fakePdf(1_024, 'smuggled.pdf')),
    as,
  });
/** Every receipt row of these claims as text (incl. storage keys and hashes). */
const receiptsOf = async (...ids: string[]) =>
  (
    await ownerSql<{ s: string | null }>`
      SELECT json_agg(r ORDER BY r.id)::text AS s FROM receipts r WHERE r.claim_id = ANY(${ids}::uuid[])`
  )[0]!.s;

it("uploading a receipt to another claim's line returns 404", async () => {
  const before = await Promise.all([mine, myOther, victim].map((c) => snapshot(c.id)));

  // A foreign line under MY claim id: another employee's, or one of my own other claim
  for (const foreign of [victim.lineItems[0]!, myOther.lineItems[0]!]) {
    const res = await uploadTo(mine.id, foreign.id);
    const { error } = await errorOf(res);
    expect([res.status, error.code]).toEqual([404, 'LINE_ITEM_NOT_FOUND']);
    expect(JSON.stringify(error)).not.toContain(foreign.description);
  }
  // A line id that exists nowhere gets the same answer as a real foreign one (no oracle)
  const random = await uploadTo(mine.id, randomUUID());
  expect([random.status, (await errorOf(random)).error.code]).toEqual([404, 'LINE_ITEM_NOT_FOUND']);
  // The victim's own claim id: not mine, so the claim itself is not found
  const direct = await uploadTo(victim.id, victim.lineItems[0]!.id);
  expect([direct.status, (await errorOf(direct)).error.code]).toEqual([404, 'CLAIM_NOT_FOUND']);

  // Nothing was written: no row anywhere, no object stored, every claim byte-identical
  expect(await receiptsOf(mine.id, myOther.id, victim.id)).toBeNull();
  expect(memoryStorage().size).toBe(0);
  expect(await Promise.all([mine, myOther, victim].map((c) => snapshot(c.id)))).toEqual(before);

  // Positive control: my own line on my own claim accepts it
  const ok = await uploadTo(mine.id, mine.lineItems[0]!.id);
  expect(ok.status).toBe(201);
  expect(memoryStorage().size).toBe(1);
});

it("downloading or deleting another claim's receipt through my claim id returns 404 RECEIPT_NOT_FOUND", async () => {
  // Neha's receipt, live and frozen into her submitted revision 1; and a receipt on another of
  // Asha's own claims
  const nehas = await submitAs(
    'neha',
    await makeDraft('neha', {
      title: 'Neha conference',
      lines: [{ amountMinor: 50_000, receipt: fakePdf(2_048, 'neha-hotel.pdf') }],
    }),
  );
  const ashas = await makeDraft('asha', {
    lines: [{ amountMinor: 3_000, receipt: fakePdf(2_048, 'asha-other.pdf') }],
  });
  const foreign = [nehas.lineItems[0]!.receipts[0]!, ashas.lineItems[0]!.receipts[0]!];
  const before = await receiptsOf(nehas.id, ashas.id);
  const objects = memoryStorage().keys();
  expect(objects).toHaveLength(2);

  for (const r of foreign) {
    const path = `/api/v1/claims/${mine.id}/receipts/${r.id}`;
    const params = { claimId: mine.id, receiptId: r.id };
    const get = await callRoute(contentRoute, 'GET', {
      path: `${path}/content`,
      params,
      as: 'asha',
    });
    const del = await callRoute(receiptRoute, 'DELETE', { path, params, as: 'asha' });
    for (const res of [get, del]) {
      const body = await res.text();
      expect([res.status, (JSON.parse(body) as { error: { code: string } }).error.code]).toEqual([
        404,
        'RECEIPT_NOT_FOUND',
      ]);
      expect(body).not.toContain(r.fileName); // no bytes, no name
    }
  }
  // and Asha can't reach Neha's receipt through Neha's claim id either
  const direct = await callRoute(contentRoute, 'GET', {
    path: `/api/v1/claims/${nehas.id}/receipts/${foreign[0]!.id}/content`,
    params: { claimId: nehas.id, receiptId: foreign[0]!.id },
    as: 'asha',
  });
  expect([direct.status, (await errorOf(direct)).error.code]).toEqual([404, 'CLAIM_NOT_FOUND']);

  expect(await receiptsOf(nehas.id, ashas.id)).toBe(before); // still there, unchanged
  expect(memoryStorage().keys()).toEqual(objects);
  // Positive control: through its own claim id, Asha's other receipt downloads
  const own = await callRoute(contentRoute, 'GET', {
    path: `/api/v1/claims/${ashas.id}/receipts/${foreign[1]!.id}/content`,
    params: { claimId: ashas.id, receiptId: foreign[1]!.id },
    as: 'asha',
  });
  expect(own.status).toBe(200);
});
