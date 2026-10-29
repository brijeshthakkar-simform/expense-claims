// TC-I24 (§3.5-a, §6-6): GET /api/v1/claims lists the caller's own claims only, newest first,
// with strict status / IST-date filters and keyset pages (04 §5.4, §8). Backdated rows are owner
// inserts (only the owner may supply created_at, D-23); everything else goes through the API.
import { describe, expect, it } from 'vitest';
import * as claimsRoute from '@/app/api/v1/claims/route';
import { ClaimSummaryPage } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { captureQueries, ownerSql } from '../../helpers/db';
import { categoryIds, makeDraft, submitAs } from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const list = (as: Persona, query: Record<string, string> = {}) =>
  callRoute(claimsRoute, 'GET', { path: '/api/v1/claims', as, query });
async function page(as: Persona, query: Record<string, string> = {}) {
  const res = await list(as, query);
  expect(res.status, JSON.stringify(query)).toBe(200);
  return ClaimSummaryPage.parse(await res.json()); // the wire contract the client parses with
}
const ids = async (as: Persona, query: Record<string, string> = {}) =>
  (await page(as, query)).data.map((c) => c.id);

/** An owner-inserted draft with a chosen created_at (the app role's created_at is always now()). */
async function draftAt(who: Persona, createdAt: string, title = `At ${createdAt}`) {
  const { id } = await asPersona(who);
  const [row] = await ownerSql<{ id: string }>`
    INSERT INTO claims (claimant_id, title, created_at) VALUES (${id}, ${title}, ${createdAt}::timestamptz)
    RETURNING id`;
  return row!.id;
}

/**
 * A SUBMITTED fixture on an owner-backdated draft: one line, then a real submit through the
 * service (submit never touches created_at, so the IST date filters still see the backdated day).
 */
async function forceSubmitted(claimId: string) {
  const cats = await categoryIds();
  await ownerSql`
    INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
    VALUES (${claimId}, ${cats.MEALS}, DATE '2026-09-15', 1000, 'Fixture line')`;
  await submitAs('asha', { id: claimId });
}

describe('TC-I24 claimant list', () => {
  it("returns only the caller's claims", async () => {
    const asha = await Promise.all([1, 2, 3].map(() => makeDraft('asha')));
    const neha = await Promise.all([1, 2].map(() => makeDraft('neha')));
    const farah = await makeDraft('farah'); // FINANCE reads every claim by id, but lists only her own here

    expect((await ids('asha')).sort()).toEqual(asha.map((c) => c.id).sort());
    expect((await ids('neha')).sort()).toEqual(neha.map((c) => c.id).sort());
    expect(await ids('farah')).toEqual([farah.id]);
    expect(await ids('ravi')).toEqual([]); // Asha's manager sees none of her claims here

    const first = await page('asha');
    expect(first.page).toEqual({ nextCursor: null, limit: 25 });
    const row = first.data.find((c) => c.id === asha[0]!.id);
    expect(row).toMatchObject({
      claimNumber: asha[0]!.claimNumber,
      status: 'DRAFT',
      totalMinor: 0,
      lineItemCount: 0,
      currentRevision: 0,
    });
    // One statement per page (06 §7 rule 5): the line count is correlated to the page's rows, never
    // a GROUP BY over the whole line_items table (Prisma's `_count`)
    const queries = captureQueries();
    await page('asha');
    const pageSql = queries.filter((q) => /line_items/.test(q));
    expect(pageSql).toHaveLength(1);
    expect(pageSql[0]).toMatch(/WHERE li\.claim_id = c\.id[\s\S]*FROM public\.claims c/);
    expect(pageSql[0]).not.toMatch(/GROUP BY/i);
    // An explicit filter can't widen the scope: there is no claimant param to try
    const res = await list('asha', { claimantId: neha[0]!.id });
    expect(res.status).toBe(422);
  });

  it('filters by status and IST created date', async () => {
    // Boundaries of September 2026 in IST: [2026-08-31T18:30:00.000Z, 2026-09-30T18:30:00.000Z)
    const beforeSep = await draftAt('asha', '2026-08-31T18:29:59.999Z'); // 31 Aug 23:59:59.999 IST
    const sepFirst = await draftAt('asha', '2026-08-31T18:30:00.000Z'); // 1 Sep 00:00 IST
    const sepMid = await draftAt('asha', '2026-09-15T06:00:00.000Z');
    const sepLast = await draftAt('asha', '2026-09-30T18:29:59.999Z'); // 30 Sep 23:59:59.999 IST
    const octFirst = await draftAt('asha', '2026-09-30T18:30:00.000Z'); // 1 Oct 00:00 IST
    await draftAt('neha', '2026-09-15T06:00:00.000Z'); // never in Asha's results
    await forceSubmitted(sepMid);

    // newest first
    expect(await ids('asha', { from: '2026-09-01', to: '2026-09-30' })).toEqual([
      sepLast,
      sepMid,
      sepFirst,
    ]);
    expect(await ids('asha', { from: '2026-10-01' })).toEqual([octFirst]);
    expect(await ids('asha', { to: '2026-08-31' })).toEqual([beforeSep]);
    expect(await ids('asha', { from: '2026-09-30', to: '2026-09-30' })).toEqual([sepLast]);
    expect(await ids('asha', { from: '2026-09-01', to: '2026-09-01' })).toEqual([sepFirst]);

    expect(await ids('asha', { status: 'SUBMITTED' })).toEqual([sepMid]);
    expect(await ids('asha', { status: 'DRAFT' })).toEqual([
      octFirst,
      sepLast,
      sepFirst,
      beforeSep,
    ]);
    expect(await ids('asha', { status: 'APPROVED,REJECTED' })).toEqual([]);
    expect(await ids('asha', { status: 'SUBMITTED,DRAFT' })).toHaveLength(5);
    expect(await ids('asha', { status: 'DRAFT', from: '2026-09-01', to: '2026-09-30' })).toEqual([
      sepLast,
      sepFirst,
    ]);
    const submitted = (await page('asha', { status: 'SUBMITTED' })).data[0];
    expect(submitted).toMatchObject({ status: 'SUBMITTED', totalMinor: 1000, lineItemCount: 1 });

    const backwards = await list('asha', { from: '2026-09-30', to: '2026-09-01' });
    expect([backwards.status, (await errorOf(backwards)).error.code]).toEqual([
      422,
      'VALIDATION_FAILED',
    ]);
  });

  it('keyset pages are complete and disjoint including ties', async () => {
    // 9 claims on 4 instants, so most page boundaries fall inside a tie (id breaks it)
    const instants = [
      ...Array<string>(3).fill('2026-09-10T04:30:00.000Z'),
      '2026-09-11T04:30:00.000Z',
      ...Array<string>(4).fill('2026-09-12T04:30:00.000Z'),
      '2026-09-13T04:30:00.000Z',
    ];
    for (const at of instants) await draftAt('asha', at);
    await draftAt('neha', '2026-09-12T04:30:00.000Z'); // a tie in someone else's scope
    const expected = (
      await ownerSql<{ id: string }>`
        SELECT c.id FROM claims c JOIN users u ON u.id = c.claimant_id
         WHERE u.email = 'asha.rao@acme.test' ORDER BY c.created_at DESC, c.id DESC`
    ).map((r) => r.id);
    expect(expected).toHaveLength(9);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: ClaimSummaryPage = await page('asha', { limit: '2', ...(cursor ? { cursor } : {}) });
      expect(p.page.limit).toBe(2);
      expect(p.data.length).toBeLessThanOrEqual(2);
      seen.push(...p.data.map((c) => c.id));
      cursor = p.page.nextCursor;
      if (pages === 0) await makeDraft('asha'); // a claim created mid-paging is newer: never on a later page
      pages++;
    } while (cursor && pages < 20);

    expect(pages).toBe(5); // 2+2+2+2+1, and the last page says there is no next one
    expect(seen).toEqual(expected); // complete, disjoint and in order
    expect(new Set(seen).size).toBe(seen.length);

    // a cursor is bound to its filters (not to limit)
    const first = await page('asha', { limit: '2' });
    const next = first.page.nextCursor!;
    expect((await list('asha', { cursor: next, limit: '5' })).status).toBe(200);
    const reused = await list('asha', { cursor: next, status: 'DRAFT' });
    expect([reused.status, (await errorOf(reused)).error.code]).toEqual([422, 'INVALID_CURSOR']);
    const garbage = await list('asha', { cursor: 'bm9wZQ' });
    expect([garbage.status, (await errorOf(garbage)).error.code]).toEqual([422, 'INVALID_CURSOR']);
    // a cursor carries a position, not a permission: replayed by Neha it only moves HER window
    const nehaIds = (
      await ownerSql<{ id: string }>`
        SELECT c.id FROM claims c JOIN users u ON u.id = c.claimant_id
         WHERE u.email = 'neha.kapoor@acme.test'`
    ).map((r) => r.id);
    expect(nehaIds).toHaveLength(1);
    expect(nehaIds).toEqual(expect.arrayContaining(await ids('neha', { cursor: next })));
  });

  it('an unknown query param returns 422', async () => {
    await makeDraft('asha');
    const unknown: Record<string, string>[] = [
      { sort: 'createdAt:asc' },
      { page: '2' },
      { offset: '25' },
      { q: 'cab' },
    ];
    for (const query of unknown) {
      const res = await list('asha', query);
      const { error } = await errorOf(res);
      expect([query, res.status, error.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
    const badValues: Record<string, string>[] = [
      { status: 'PAID' },
      { limit: '101' },
      { limit: '0' },
      { from: '2026-02-30' },
    ];
    for (const query of badValues) {
      const res = await list('asha', query);
      expect([query, res.status]).toEqual([query, 422]);
    }
    expect((await list('asha', { limit: '100' })).status).toBe(200); // positive control
  });
});
