// TC-I09 (§2-Claimant, §3.1, RT-m4): draft CRUD through the real route handlers. The
// "DELETE of a claim that was ever submitted returns 409 CLAIM_HAS_HISTORY" case landed in P3 with
// submit; P5 adds a recalled draft (DRAFT at revision ≥ 1) to it.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as claimsRoute from '@/app/api/v1/claims/route';
import { todayInBusinessTz } from '@/shared/dates';
import { ClaimDetail } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { appSql, ownerSql, rejects } from '../../helpers/db';
import { categoryIds, lineInput, makeDraft, recallAs, submitAs } from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const today = todayInBusinessTz();
const total = async (id: string) =>
  (await ownerSql<{ t: number }>`SELECT total_minor AS t FROM claims WHERE id = ${id}`)[0]?.t;
const linesOf = (id: string) => ownerSql<{ id: string; amount_minor: number; description: string }>`
  SELECT id, amount_minor, description FROM line_items WHERE claim_id = ${id} ORDER BY id`;
/** The claim row plus its lines, as text: byte-for-byte comparison including updated_at. */
const snapshot = async (id: string) =>
  (
    await ownerSql<{ s: string }>`SELECT json_build_object(
      'claim', (SELECT row_to_json(c) FROM claims c WHERE c.id = ${id}),
      'lines', (SELECT json_agg(l ORDER BY l.id) FROM line_items l WHERE l.claim_id = ${id}))::text AS s`
  )[0]!.s;

const put = (as: Persona, id: string, body: unknown) =>
  callRoute(claimRoute, 'PUT', { path: `/api/v1/claims/${id}`, params: { claimId: id }, as, body });
const del = (as: Persona, id: string) =>
  callRoute(claimRoute, 'DELETE', { path: `/api/v1/claims/${id}`, params: { claimId: id }, as });
const get = (as: Persona, id: string) =>
  callRoute(claimRoute, 'GET', { path: `/api/v1/claims/${id}`, params: { claimId: id }, as });
/** The error body without its per-request id. */
const bodyOf = async (r: Response) => {
  const b = await errorOf(r);
  return { status: r.status, error: { ...b.error, requestId: undefined } };
};

describe('TC-I09 claims CRUD', () => {
  it('POST /claims creates an empty DRAFT with total 0 and a claim number', async () => {
    const asha = await asPersona('asha');
    const res = await callRoute(claimsRoute, 'POST', {
      path: '/api/v1/claims',
      as: 'asha',
      body: { title: '  Client visit Pune  ' },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: unknown };
    const claim = ClaimDetail.parse(data); // the wire contract the client parses with
    expect(claim).toMatchObject({
      title: 'Client visit Pune',
      status: 'DRAFT',
      currency: 'INR',
      totalMinor: 0,
      currentRevision: 0,
      claimant: { id: asha.id, name: asha.name },
      lineItems: [],
      submittedAt: null,
      approvedAt: null,
      rejectedAt: null,
      approval: null,
      allowedActions: ['EDIT', 'SUBMIT', 'DELETE'],
    });
    expect(claim.claimNumber).toMatch(/^EXP-\d{4}-\d{6,}$/);
    expect(await ownerSql`SELECT claimant_id, status::text, total_minor FROM claims`).toEqual([
      { claimant_id: asha.id, status: 'DRAFT', total_minor: 0 },
    ]);

    // Three more back to back: consecutive numbers (guards the sequence double-draw bug)
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await callRoute(claimsRoute, 'POST', {
        path: '/api/v1/claims',
        as: 'asha',
        body: { title: `Claim ${i}` },
      });
      numbers.push(((await r.json()) as { data: { claimNumber: string } }).data.claimNumber);
    }
    const seq = [claim.claimNumber, ...numbers].map((n) => Number(n.split('-')[2]));
    expect(seq.slice(1).map((n, i) => n - seq[i]!)).toEqual([1, 1, 1]);

    // POST may carry the first lines; the total is still the DB's
    const cats = await categoryIds();
    const withLines = await callRoute(claimsRoute, 'POST', {
      path: '/api/v1/claims',
      as: 'asha',
      body: {
        title: 'With lines',
        lineItems: [
          { expenseDate: today, categoryId: cats.MEALS, amountMinor: 10, description: 'Tea' },
          { expenseDate: today, categoryId: cats.MEALS, amountMinor: 20, description: 'Coffee' },
        ],
      },
    });
    expect(withLines.status).toBe(201);
    const created = ClaimDetail.parse(((await withLines.json()) as { data: unknown }).data);
    expect(created.totalMinor).toBe(30);
    expect(await total(created.id)).toBe(30);
  });

  it('PUT replace-set inserts, updates and deletes lines in one transaction', async () => {
    const c = await makeDraft('asha', {
      title: 'Hyderabad trip',
      lines: [
        { amountMinor: 100, description: 'keep me' },
        { amountMinor: 200, description: 'update me' },
        { amountMinor: 300, description: 'delete me' },
      ],
    });
    expect(c.totalMinor).toBe(600);
    const [keep, update, remove] = ['keep me', 'update me', 'delete me'].map((d) =>
      c.lineItems.find((l) => l.description === d)!,
    );
    const cats = await categoryIds();
    const body = {
      title: 'Hyderabad trip (final)',
      lineItems: [
        lineInput(keep!),
        { ...lineInput(update!), amountMinor: 250, description: 'updated', merchant: 'Ola' },
        { expenseDate: today, categoryId: cats.LODGING!, amountMinor: 400, description: 'new' },
      ],
    };

    // Atomicity first: if the last write step (the INSERT) fails, the DELETE and UPDATE that ran
    // before it in the same transaction roll back with it.
    const before = await snapshot(c.id);
    await ownerSql`REVOKE INSERT ON line_items FROM expense_app`;
    try {
      const failed = await put('asha', c.id, body);
      expect(failed.status).toBe(500); // 42501: a backstop, never a partial write
    } finally {
      await ownerSql`GRANT INSERT ON line_items TO expense_app`;
    }
    expect(await snapshot(c.id)).toBe(before);

    const res = await put('asha', c.id, body);
    expect(res.status).toBe(200);
    const after = ClaimDetail.parse(((await res.json()) as { data: unknown }).data);
    expect(after.title).toBe('Hyderabad trip (final)');
    expect(after.totalMinor).toBe(100 + 250 + 400);
    expect(await total(c.id)).toBe(750);
    const byDesc = Object.fromEntries(after.lineItems.map((l) => [l.description, l]));
    expect(Object.keys(byDesc).sort()).toEqual(['keep me', 'new', 'updated']);
    expect(byDesc['keep me']!.id).toBe(keep!.id); // kept: same row
    expect(byDesc.updated).toMatchObject({ id: update!.id, amountMinor: 250, merchant: 'Ola' }); // updated in place
    expect(byDesc.new!.id).not.toBe(remove!.id); // inserted: a fresh row
    expect(byDesc.new!.category.code).toBe('LODGING');
    expect((await linesOf(c.id)).map((l) => l.id).sort()).toEqual(
      [keep!.id, update!.id, byDesc.new!.id].sort(),
    );

    // An empty set deletes every line; the total follows to 0
    const emptied = await put('asha', c.id, { title: after.title, lineItems: [] });
    expect(emptied.status).toBe(200);
    expect(await total(c.id)).toBe(0);
    expect(await linesOf(c.id)).toEqual([]);
  });

  it('DELETE of a claim that was ever submitted returns 409 CLAIM_HAS_HISTORY', async () => {
    const c = await submitAs('asha', await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] }));
    expect(c.allowedActions).not.toContain('DELETE'); // the UI never offers it
    const before = await snapshot(c.id);

    const res = await del('asha', c.id);
    expect(await bodyOf(res)).toEqual({
      status: 409,
      error: expect.objectContaining({ code: 'CLAIM_HAS_HISTORY' }),
    });
    // A non-owner still learns nothing: the same 404 as a random id
    const other = await del('ravi', c.id);
    expect(await bodyOf(other)).toEqual(await bodyOf(await del('ravi', randomUUID())));
    // The DB backstop, if the service check were bypassed: UC017 for the app and the owner alike
    await rejects('UC017', () => appSql`DELETE FROM claims WHERE id = ${c.id}`);
    await rejects('UC017', () => ownerSql`DELETE FROM claims WHERE id = ${c.id}`);

    expect(await snapshot(c.id)).toBe(before); // the claim, its lines and its history remain
    const [kept] = await ownerSql`
      SELECT (SELECT count(*)::int FROM claim_submissions WHERE claim_id = ${c.id}) AS submissions,
             (SELECT count(*)::int FROM claim_events WHERE claim_id = ${c.id}) AS events`;
    expect(kept).toEqual({ submissions: 1, events: 1 });

    // P5: a recalled claim is a DRAFT again, but at revision 1: editable, never deletable
    const recalled = await recallAs('asha', c);
    expect(recalled).toMatchObject({ status: 'DRAFT', currentRevision: 1 });
    expect(recalled.allowedActions).toEqual(['EDIT', 'SUBMIT']);
    const afterRecall = await snapshot(c.id);
    expect(await bodyOf(await del('asha', c.id))).toEqual({
      status: 409,
      error: expect.objectContaining({ code: 'CLAIM_HAS_HISTORY' }),
    });
    await rejects('UC017', () => appSql`DELETE FROM claims WHERE id = ${c.id}`);
    expect(await snapshot(c.id)).toBe(afterRecall);
  });

  it('DELETE removes a never-submitted draft (204)', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }, { amountMinor: 2_000 }] });
    const res = await del('asha', c.id);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await ownerSql`SELECT id FROM claims WHERE id = ${c.id}`).toEqual([]);
    expect(await linesOf(c.id)).toEqual([]); // cascaded
    const again = await get('asha', c.id);
    expect([again.status, (await errorOf(again)).error.code]).toEqual([404, 'CLAIM_NOT_FOUND']);
    const twice = await del('asha', c.id);
    expect([twice.status, (await errorOf(twice)).error.code]).toEqual([404, 'CLAIM_NOT_FOUND']);
  });

  it('non-owner PUT and DELETE return 404 CLAIM_NOT_FOUND', async () => {
    const c = await makeDraft('asha', { title: 'Private trip', lines: [{ amountMinor: 5_000 }] });
    const before = await snapshot(c.id);
    const random = randomUUID();
    const hijack = { title: 'Hijacked', lineItems: [] };
    // neha: unrelated approver; ravi: Asha's own manager (no step yet); farah: FINANCE, who may
    // READ the draft but never write it; arjun: unrelated employee
    for (const who of ['neha', 'ravi', 'farah', 'arjun', 'admin'] as const) {
      for (const [verb, send] of [
        ['PUT', (id: string) => put(who, id, hijack)],
        ['DELETE', (id: string) => del(who, id)],
      ] as const) {
        const [real, none] = [await bodyOf(await send(c.id)), await bodyOf(await send(random))];
        expect([who, verb, real]).toEqual([
          who,
          verb,
          { status: 404, error: expect.objectContaining({ code: 'CLAIM_NOT_FOUND' }) },
        ]);
        expect([who, verb, real]).toEqual([who, verb, none]); // identical to a random id
      }
    }
    expect(await snapshot(c.id)).toBe(before);
    expect((await get('farah', c.id)).status).toBe(200); // finance reads drafts (04 §4.1)
    expect((await get('neha', c.id)).status).toBe(404);
  });

  it('concurrent PUTs on one draft end last-write-wins with no drift', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 1 }] });
    const cats = await categoryIds();
    const bodyFor = (k: number) => ({
      title: `Version ${k}`,
      lineItems: Array.from({ length: k }, (_, i) => ({
        expenseDate: today,
        categoryId: cats.MEALS!,
        amountMinor: 100 * k + i,
        description: `v${k} line ${i}`,
      })),
    });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => put('asha', c.id, bodyFor(k))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);

    // Exactly one PUT's state survived, whole: its title AND its lines, and the total matches them
    const [{ title } = { title: '' }] = await ownerSql<{ title: string }>`
      SELECT title FROM claims WHERE id = ${c.id}`;
    const k = Number(title.replace('Version ', ''));
    const lines = await linesOf(c.id);
    expect(lines.map((l) => l.description).sort()).toEqual(
      bodyFor(k)
        .lineItems.map((l) => l.description)
        .sort(),
    );
    expect(await total(c.id)).toBe(lines.reduce((s, l) => s + l.amount_minor, 0));
    expect(await ownerSql`SELECT * FROM v_claim_total_drift`).toEqual([]);
  });
});
