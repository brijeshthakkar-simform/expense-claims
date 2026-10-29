// TC-I10 (§6-1, §3.1-a): a line needs a positive amount, a real past-or-today date (IST) and a real
// category. The API refuses with 422 at the exact field path (so the form can show it there), and
// the database refuses the same values on its own when the API is bypassed (04 §10.3).
import { describe, expect, it } from 'vitest';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import { mapError } from '@/server/errors/map-error';
import { addDaysYmd, todayInBusinessTz } from '@/shared/dates';
import { MAX_LINE_ITEMS } from '@/shared/policy';
import { appSql, errorOf as dbErrorOf, ownerSql, rejects } from '../../helpers/db';
import { categoryIds, lineInput, makeDraft, type ClaimDetail } from '../../helpers/factories';
import { callRoute, errorOf } from '../../helpers/http';

const UNKNOWN_CATEGORY = '0199c0de-dead-7000-8000-000000000000';
const today = () => todayInBusinessTz();

/** The draft's lines and total, as text: a refused PUT must leave both exactly as they were. */
const state = async (id: string) =>
  (
    await ownerSql<{ s: string }>`SELECT json_build_object(
      'total', (SELECT total_minor FROM claims WHERE id = ${id}),
      'lines', (SELECT json_agg(l ORDER BY l.id) FROM line_items l WHERE l.claim_id = ${id}))::text AS s`
  )[0]!.s;

const putLines = (c: ClaimDetail, lineItems: unknown[], extra: Record<string, unknown> = {}) =>
  callRoute(claimRoute, 'PUT', {
    path: `/api/v1/claims/${c.id}`,
    params: { claimId: c.id },
    as: 'asha',
    body: { title: c.title, lineItems, ...extra },
  });

type Case = [
  label: string,
  patch: (cats: Record<string, string>) => Record<string, unknown>,
  field: string,
];
const CASES: Case[] = [
  ['amount 0', () => ({ amountMinor: 0 }), 'amountMinor'],
  ['amount negative', () => ({ amountMinor: -500 }), 'amountMinor'],
  ['amount non-integer', () => ({ amountMinor: 1250.5 }), 'amountMinor'],
  ['amount over the per-line cap', () => ({ amountMinor: 100_000_001 }), 'amountMinor'],
  ['date 2026-02-30', () => ({ expenseDate: '2026-02-30' }), 'expenseDate'],
  ['date 2026-13-01', () => ({ expenseDate: '2026-13-01' }), 'expenseDate'],
  ['date in DD/MM/YYYY', () => ({ expenseDate: '30/09/2026' }), 'expenseDate'],
  ['date in the future (IST)', () => ({ expenseDate: addDaysYmd(today(), 1) }), 'expenseDate'],
  ['unknown category', () => ({ categoryId: UNKNOWN_CATEGORY }), 'categoryId'],
  ['missing category', () => ({ categoryId: undefined }), 'categoryId'],
  ['empty description', () => ({ description: '' }), 'description'],
  ['description over 500 characters', () => ({ description: 'x'.repeat(501) }), 'description'],
];

describe('TC-I10 line item validation', () => {
  it.each(CASES)(
    'rejects %s with 422 VALIDATION_FAILED at the field path',
    async (_, patch, field) => {
      const cats = await categoryIds();
      const c = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
      const before = await state(c.id);
      const good = {
        expenseDate: today(),
        categoryId: cats.MEALS,
        amountMinor: 700,
        description: 'Taxi',
      };
      // the bad line is the SECOND one, next to a kept line: the path must name index 1
      const res = await putLines(c, [lineInput(c.lineItems[0]!), { ...good, ...patch(cats) }]);
      expect(res.status).toBe(422);
      const { error } = await errorOf(res);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details?.issues).toEqual([
        expect.objectContaining({ path: ['lineItems', 1, field], message: expect.any(String) }),
      ]);
      expect(await state(c.id)).toBe(before); // nothing written
    },
  );

  it('inactive category returns 422 CATEGORY_INACTIVE', async () => {
    const cats = await categoryIds();
    const c = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    const before = await state(c.id);
    const retired = {
      expenseDate: today(),
      categoryId: cats.LEGACY_PER_DIEM,
      amountMinor: 50_000,
      description: 'Per diem',
    };
    // a new line …
    const res = await putLines(c, [lineInput(c.lineItems[0]!), retired]);
    expect(res.status).toBe(422);
    const { error } = await errorOf(res);
    expect(error).toMatchObject({
      code: 'CATEGORY_INACTIVE',
      details: { issues: [expect.objectContaining({ path: ['lineItems', 1, 'categoryId'] })] },
    });
    // … or a kept line switched to it
    const switched = await putLines(c, [
      { ...lineInput(c.lineItems[0]!), categoryId: cats.LEGACY_PER_DIEM },
    ]);
    expect([switched.status, (await errorOf(switched)).error.code]).toEqual([
      422,
      'CATEGORY_INACTIVE',
    ]);
    expect(await state(c.id)).toBe(before);

    // A line that already has a category retired later keeps it (like the UC013 trigger): the
    // claimant can still edit other fields without being forced to recategorise.
    await ownerSql`UPDATE categories SET is_active = false WHERE code = 'MEALS'`; // resetDb restores it
    const kept = await putLines(c, [
      { ...lineInput(c.lineItems[0]!), description: 'Edited later' },
    ]);
    expect(kept.status).toBe(200);
  });

  it('totalMinor in the body returns 422 TOTAL_IS_DERIVED', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    const before = await state(c.id);
    const res = await putLines(c, c.lineItems.map(lineInput), { totalMinor: 999_999 });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).error).toMatchObject({
      code: 'TOTAL_IS_DERIVED',
      details: { issues: [expect.objectContaining({ path: ['totalMinor'] })] },
    });
    expect(await state(c.id)).toBe(before);
  });

  it('51 lines return 422 VALIDATION_FAILED', async () => {
    const cats = await categoryIds();
    const c = await makeDraft('asha');
    const line = (i: number) => ({
      expenseDate: today(),
      categoryId: cats.MEALS,
      amountMinor: 100 + i,
      description: `Line ${i}`,
    });
    const tooMany = await putLines(
      c,
      Array.from({ length: MAX_LINE_ITEMS + 1 }, (_, i) => line(i)),
    );
    expect(tooMany.status).toBe(422);
    expect((await errorOf(tooMany)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [expect.objectContaining({ path: ['lineItems'] })] },
    });
    expect(await ownerSql`SELECT count(*)::int AS n FROM line_items`).toEqual([{ n: 0 }]);
    // positive control: exactly 50 is fine
    const fifty = await putLines(
      c,
      Array.from({ length: MAX_LINE_ITEMS }, (_, i) => line(i)),
    );
    expect(fifty.status).toBe(200);
    expect(await ownerSql`SELECT count(*)::int AS n FROM line_items`).toEqual([{ n: 50 }]);
  });

  it('DB backstops: raw amount_minor = 0 → 23514, raw future expense_date → UC014, raw inactive category → UC013', async () => {
    const cats = await categoryIds();
    const c = await makeDraft('asha');
    const insert = (o: { amount?: number; date?: string; category?: string }) => appSql`
      INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
      VALUES (${c.id}, ${o.category ?? cats.MEALS}, ${o.date ?? today()}, ${o.amount ?? 100}, 'raw insert')`;

    const zero = await rejects('23514', () => insert({ amount: 0 }));
    const future = await rejects('UC014', () => insert({ date: addDaysYmd(today(), 2) }));
    const inactive = await rejects('UC013', () => insert({ category: cats.LEGACY_PER_DIEM }));
    // … and each maps back to the same 422 the service gives
    expect([zero, future, inactive].map((e) => [mapError(e).status, mapError(e).code])).toEqual([
      [422, 'VALIDATION_FAILED'],
      [422, 'VALIDATION_FAILED'],
      [422, 'CATEGORY_INACTIVE'],
    ]);
    // the other DB rules behind the it.each cases
    await rejects('23514', () => insert({ amount: 100_000_001 }));
    await rejects('23514', () => insert({ date: '1999-12-31' }));
    await rejects('23503', () => insert({ category: UNKNOWN_CATEGORY }));
    expect(await dbErrorOf(() => insert({ amount: 100 }))).toBeNull(); // positive control
    expect(await ownerSql`SELECT count(*)::int AS n FROM line_items`).toEqual([{ n: 1 }]);
  });
});
