// TC-I17 (§6-4, §3.2-c, §1): the sharpest authz test (07 §8), in its P4 routed-approver form.
// C02 (Asha ₹8,000) is PENDING with Ravi; Neha is an approver, but not in its chain (C-15). C08
// (Arjun ₹5,000) is PENDING with Neha: the positive control that proves her queue works.
// "Refused at the point of the query" = the ONE SELECT that loads the claim carries the owner and
// step predicates, Postgres returns zero rows, the API's 404 is identical to the one for a random
// UUID, commands get the specific 403 NOT_IN_YOUR_QUEUE, and nothing in the database changes.
// P5 added the history and recall rows, P6 the three receipt rows and the `receipts` column.
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import * as approveRoute from '@/app/api/v1/claims/[claimId]/approve/route';
import * as historyRoute from '@/app/api/v1/claims/[claimId]/history/route'; // P5
import * as uploadRoute from '@/app/api/v1/claims/[claimId]/line-items/[lineItemId]/receipts/route'; // P6
import * as receiptContentRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/content/route'; // P6
import * as receiptRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/route'; // P6
import * as recallRoute from '@/app/api/v1/claims/[claimId]/recall/route'; // P5
import * as rejectRoute from '@/app/api/v1/claims/[claimId]/reject/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as submitRoute from '@/app/api/v1/claims/[claimId]/submit/route';
import { withTx } from '@/server/db/tx';
import { findClaimForActor } from '@/server/repositories/claim-visibility';
import { lockClaimRoutedToMe } from '@/server/repositories/claims.repo';
import { asPersona } from '../../helpers/auth';
import { captureQueries, ownerSql } from '../../helpers/db';
import {
  fakePdf,
  makeDraft,
  memoryStorage,
  pdfForm,
  submitAs,
  type ClaimDetail,
} from '../../helpers/factories';
import { callRoute, type Method, type RouteModule } from '../../helpers/http';

let c02: ClaimDetail; // Asha ₹8,000 → PENDING with Ravi. Neha is NOT in its chain (C-15)
let c08: ClaimDetail; // Arjun ₹5,000 → PENDING with Neha: the positive control
let receiptId: string; // C02's receipt (P6)

beforeEach(async () => {
  // resetDb() already ran (integration-setup.ts)
  c02 = await submitAs(
    'asha',
    await makeDraft('asha', {
      title: 'Cab to client site',
      lines: [{ amountMinor: 800_000, receipt: fakePdf(2_048, 'cab-receipt.pdf') }],
    }),
  );
  c08 = await submitAs('arjun', await makeDraft('arjun', { lines: [{ amountMinor: 500_000 }] }));
  receiptId = c02.lineItems[0]!.receipts[0]!.id;
  expect(c02.approval?.steps.map((s) => s.approver.name)).toEqual(['Ravi Menon']); // fixture sanity
  expect(c08.approval?.steps.map((s) => s.approver.name)).toEqual(['Neha Kapoor']);
});

interface Attempt {
  name: string;
  mod: RouteModule;
  method: Method;
  path: string;
  params: Record<string, string>;
  body?: unknown;
  want: [number, string];
}

/** Everything Neha could try against C02, with the one answer each must get (C-02 / C-06). */
const attempts = (): Attempt[] => {
  const id = c02.id;
  const lineItemId = c02.lineItems[0]!.id;
  const p = { claimId: id };
  // P4 rows, history and recall (P5), and the three receipt routes (P6)
  return [
    {
      name: 'GET claim',
      mod: claimRoute,
      method: 'GET',
      path: `/api/v1/claims/${id}`,
      params: p,
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'GET history',
      mod: historyRoute,
      method: 'GET',
      path: `/api/v1/claims/${id}/history`,
      params: p,
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'GET receipt',
      mod: receiptContentRoute,
      method: 'GET',
      path: `/api/v1/claims/${id}/receipts/${receiptId}/content`,
      params: { ...p, receiptId },
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'upload receipt',
      mod: uploadRoute,
      method: 'POST',
      path: `/api/v1/claims/${id}/line-items/${lineItemId}/receipts`,
      params: { ...p, lineItemId },
      body: pdfForm(),
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'delete receipt',
      mod: receiptRoute,
      method: 'DELETE',
      path: `/api/v1/claims/${id}/receipts/${receiptId}`,
      params: { ...p, receiptId },
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'PUT claim',
      mod: claimRoute,
      method: 'PUT',
      path: `/api/v1/claims/${id}`,
      params: p,
      body: { title: 'Hijacked', lineItems: [] },
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'DELETE claim',
      mod: claimRoute,
      method: 'DELETE',
      path: `/api/v1/claims/${id}`,
      params: p,
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'submit',
      mod: submitRoute,
      method: 'POST',
      path: `/api/v1/claims/${id}/submit`,
      params: p,
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'recall',
      mod: recallRoute,
      method: 'POST',
      path: `/api/v1/claims/${id}/recall`,
      params: p,
      body: {},
      want: [404, 'CLAIM_NOT_FOUND'],
    },
    {
      name: 'approve',
      mod: approveRoute,
      method: 'POST',
      path: `/api/v1/claims/${id}/approve`,
      params: p,
      body: { revision: 1 },
      want: [403, 'NOT_IN_YOUR_QUEUE'],
    },
    {
      name: 'reject',
      mod: rejectRoute,
      method: 'POST',
      path: `/api/v1/claims/${id}/reject`,
      params: p,
      body: { revision: 1, reason: 'Not my claim to decide' },
      want: [403, 'NOT_IN_YOUR_QUEUE'],
    },
  ];
};
const send = (a: Attempt) =>
  callRoute(a.mod, a.method, { path: a.path, params: a.params, body: a.body, as: 'neha' });
const outcome = async (r: Response): Promise<[number, string]> => [
  r.status,
  ((await r.json()) as { error: { code: string } }).error.code,
];

it('approver requesting a claim outside their queue by id is refused at the point of the query', async ({
  annotate,
}) => {
  const neha = await asPersona('neha');
  expect(neha.canApprove).toBe(true); // she IS an approver, just not for this claim
  expect(await ownerSql`SELECT status::text FROM claims WHERE id = ${c02.id}`).toEqual([
    { status: 'SUBMITTED' },
  ]); // the row exists …
  expect(await findClaimForActor(neha, c08.id, { id: true })).toEqual({ id: c08.id }); // … and Neha's own queue works

  const queries = captureQueries();
  const row = await findClaimForActor(neha, c02.id, { id: true, title: true, totalMinor: true });
  expect(row).toBeNull(); // Postgres returned zero rows

  const claimSelects = queries.filter((q) => /^\s*SELECT/i.test(q) && /"claims"/.test(q));
  expect(claimSelects).toHaveLength(1); // ONE statement: no "load, then check"
  expect(claimSelects[0]).toMatch(/"claimant_id"/); // owner branch …
  expect(claimSelects[0]).toMatch(/"approval_steps"[\s\S]*"approver_id"/); // … and step branch, in the same WHERE
  expect(claimSelects[0]).toMatch(/WHERE[\s\S]*"claimant_id"[\s\S]*EXISTS/);
  expect(queries).toHaveLength(1); // and nothing else was sent (no follow-up row fetch)
  await annotate('SQL sent by findClaimForActor (walkthrough evidence)', claimSelects[0]!);

  // The same predicate admits the routed approver (Ravi) and refuses a WAITING one: Meera on a
  // ₹25,000 claim whose level 1 (Ravi) has not decided yet
  const ravi = await asPersona('ravi');
  expect(await findClaimForActor(ravi, c02.id, { id: true })).toEqual({ id: c02.id });
  const twoStep = await submitAs(
    'asha',
    await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
  );
  expect(await findClaimForActor(await asPersona('meera'), twoStep.id, { id: true })).toBeNull();
});

it('GET /claims/:id returns 404 CLAIM_NOT_FOUND identical to the 404 for a random UUID', async () => {
  const get = (id: string) =>
    callRoute(claimRoute, 'GET', {
      path: `/api/v1/claims/${id}`,
      params: { claimId: id },
      as: 'neha',
    });
  const strip = async (r: Response) => {
    const b = (await r.json()) as { error: Record<string, unknown> };
    delete b.error.requestId;
    return { status: r.status, b };
  };
  const [real, random] = await Promise.all([
    get(c02.id).then(strip),
    get(randomUUID()).then(strip),
  ]);
  expect(real).toEqual(random); // no existence oracle
  expect(real).toMatchObject({ status: 404, b: { error: { code: 'CLAIM_NOT_FOUND' } } });
  expect(JSON.stringify(real)).not.toContain('Cab to client site'); // nothing about the claim leaks
  expect(JSON.stringify(real)).not.toContain(c02.claimNumber);

  // a malformed id gets the same answer (refused by the params schema, before any query)
  expect(await get('not-a-uuid').then(strip)).toEqual(random);
  // positive controls: the owner, the routed approver and FINANCE do see it
  for (const as of ['asha', 'ravi', 'farah'] as const) {
    const res = await callRoute(claimRoute, 'GET', {
      path: `/api/v1/claims/${c02.id}`,
      params: { claimId: c02.id },
      as,
    });
    expect([as, res.status]).toEqual([as, 200]);
  }
  // and Neha sees the claim that IS routed to her
  expect((await get(c08.id)).status).toBe(200);
});

it('history and receipt routes for that claim return 404', async () => {
  const objects = memoryStorage().keys();
  expect(objects).toHaveLength(1); // C02's receipt
  const rows = [
    'GET history',
    'GET receipt', // P6: the three receipt routes
    'upload receipt',
    'delete receipt',
  ];
  const tried = attempts().filter((x) => rows.includes(x.name));
  expect(tried.map((a) => a.name)).toEqual(rows);
  for (const a of tried)
    expect([a.name, ...(await outcome(await send(a)))]).toEqual([a.name, ...a.want]);
  expect(memoryStorage().keys()).toEqual(objects); // no upload reached the store, none was deleted

  // The receipt 404s are byte-identical to those for a random claim id, and leak nothing
  const strip = async (r: Response) => {
    const b = (await r.json()) as { error: Record<string, unknown> };
    delete b.error.requestId;
    return { status: r.status, b };
  };
  const content = (claimId: string) =>
    callRoute(receiptContentRoute, 'GET', {
      path: `/api/v1/claims/${claimId}/receipts/${receiptId}/content`,
      params: { claimId, receiptId },
      as: 'neha',
    });
  const realReceipt = await strip(await content(c02.id));
  expect(realReceipt).toEqual(await strip(await content(randomUUID())));
  expect(JSON.stringify(realReceipt)).not.toContain('cab-receipt');
  // Positive controls: the owner, the routed approver and finance download it
  for (const as of ['asha', 'ravi', 'farah'] as const) {
    const res = await callRoute(receiptContentRoute, 'GET', {
      path: `/api/v1/claims/${c02.id}/receipts/${receiptId}/content`,
      params: { claimId: c02.id, receiptId },
      as,
    });
    expect([as, res.status]).toEqual([as, 200]);
  }

  // Byte-identical to the 404 for a random UUID (no existence oracle), and nothing leaks
  // History (P5): the same, plus the shape of the refused query
  const history = (id: string) =>
    callRoute(historyRoute, 'GET', {
      path: `/api/v1/claims/${id}/history`,
      params: { claimId: id },
      as: 'neha',
    });
  const real = await strip(await history(c02.id));
  expect(real).toEqual(await strip(await history(randomUUID())));
  expect(JSON.stringify(real)).not.toContain('Cab to client site');
  expect(JSON.stringify(real)).not.toContain(c02.claimNumber);

  // Refused at the point of the query: the one claim SELECT carries the visibility predicate
  const queries = captureQueries();
  await history(c02.id);
  const claimSelects = queries.filter(
    (q) => /^\s*SELECT/i.test(q) && /FROM "public"\."claims"/.test(q),
  );
  expect(claimSelects).toHaveLength(1);
  expect(claimSelects[0]).toMatch(/WHERE[\s\S]*"claimant_id"[\s\S]*EXISTS/);
  // Prisma loads the relations in follow-up statements bound to the parent rows it got: zero, so
  // every events/submissions/steps query is `claim_id IN (NULL)` and no trail row can come back
  const children = queries.filter((q) =>
    /"(claim_events|claim_submissions|approval_steps)"\./.test(q),
  );
  expect(children.length).toBeGreaterThan(0);
  for (const q of children) expect(q).toMatch(/"claim_id" IN \(NULL\)/);

  // Positive controls: the owner, the routed approver and finance read it; Neha reads C08's
  for (const [as, id] of [
    ['asha', c02.id],
    ['ravi', c02.id],
    ['farah', c02.id],
    ['neha', c08.id],
  ] as const) {
    const res = await callRoute(historyRoute, 'GET', {
      path: `/api/v1/claims/${id}/history`,
      params: { claimId: id },
      as,
    });
    expect([as, res.status]).toEqual([as, 200]);
  }
});

it('approve and reject return 403 NOT_IN_YOUR_QUEUE', async () => {
  const neha = await asPersona('neha');
  expect(await withTx((tx) => lockClaimRoutedToMe(tx, neha, c02.id))).toBeNull(); // the write path is scoped too
  expect(await withTx((tx) => lockClaimRoutedToMe(tx, neha, c08.id))).toMatchObject({
    id: c08.id,
  }); // positive control: her own PENDING step locks
  for (const a of attempts().filter((x) => x.name === 'approve' || x.name === 'reject')) {
    const res = await send(a);
    expect([a.name, res.status]).toEqual([a.name, 403]);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: 'NOT_IN_YOUR_QUEUE',
      requestId: res.headers.get('x-request-id'),
    });
  }
});

it('nothing changes: step statuses, the claim row and claim_events are untouched', async () => {
  const snapshot = () => ownerSql`SELECT
      (SELECT row_to_json(c)::text FROM claims c WHERE c.id = ${c02.id}) AS claim,
      (SELECT json_agg(s ORDER BY s.level)::text FROM approval_steps s WHERE s.claim_id = ${c02.id}) AS steps,
      (SELECT json_agg(l ORDER BY l.id)::text FROM line_items l WHERE l.claim_id = ${c02.id}) AS lines,
      (SELECT count(*)::int FROM claim_events e WHERE e.claim_id = ${c02.id}) AS events,
      (SELECT count(*)::int FROM receipts r WHERE r.claim_id = ${c02.id}) AS receipts`; // receipts: P6
  const before = await snapshot();
  expect(before[0]).toMatchObject({ events: 1, receipts: 1 }); // CLAIM_SUBMITTED only; C02's receipt
  const objects = memoryStorage().keys();
  for (const a of attempts())
    expect([a.name, ...(await outcome(await send(a)))]).toEqual([a.name, ...a.want]);
  expect(await snapshot()).toEqual(before); // byte-identical, including updated_at
  expect(memoryStorage().keys()).toEqual(objects); // and the receipt object is untouched
  expect(
    await ownerSql`SELECT status::text FROM approval_steps WHERE claim_id = ${c02.id}`,
  ).toEqual([{ status: 'PENDING' }]); // still in Ravi's queue
});
