// TC-I12 (§3.1-c, §4-e, §6-5, RT-m10): the sharpest integrity test (07 §9.2). The total is layered
// (D-12): statement triggers recompute it, claims_guard refuses direct writes (UC003), a deferred
// COMMIT check backstops everything (UC009), and expense_app can't switch any of it off (42501).
// Every door is attacked: the API, Prisma model ops, raw SQL as expense_app, set-based SQL, COPY,
// MERGE, line moves, cascades, owner sabotage and overflow. afterEach(assertTotalsInSync) re-checks
// v_claim_total_drift after every case as well.
import { finished } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { beforeAll, describe, expect, it } from 'vitest';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import * as claimsRoute from '@/app/api/v1/claims/route';
import { getDb } from '@/server/db/client';
import { readSqlState } from '@/server/db/pg-error';
import { mapError } from '@/server/errors/map-error';
import { todayInBusinessTz } from '@/shared/dates';
import { asPersona } from '../../helpers/auth';
import {
  appClient,
  appSql,
  errorOf,
  ownerClient,
  ownerSql,
  rejects,
  tx,
  type Sql,
} from '../../helpers/db';
import { categoryIds, lineInput, makeDraft } from '../../helpers/factories';
import { callRoute, errorOf as httpErrorOf } from '../../helpers/http';

let cat: Record<string, string>;
const today = todayInBusinessTz();
beforeAll(async () => {
  cat = await categoryIds();
});
const total = async (id: string) =>
  (await ownerSql<{ t: number }>`SELECT total_minor AS t FROM claims WHERE id = ${id}`)[0]!.t;
const sumOf = async (id: string) =>
  (
    await ownerSql<{ s: number }>`
      SELECT COALESCE(SUM(amount_minor), 0)::int AS s FROM line_items WHERE claim_id = ${id}`
  )[0]!.s;
const expectInSync = async (id: string) => expect(await total(id)).toBe(await sumOf(id));
const insertLine = (sql: Sql, claimId: string, amount: number) => sql`
  INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
  VALUES (${claimId}, ${cat.MEALS}, ${today}, ${amount}, 'raw insert')`;

describe('no code path can leave claims.total_minor different from the sum of its line items', () => {
  it('API: POST and PUT with totalMinor return 422 TOTAL_IS_DERIVED and persist nothing', async () => {
    const post = await callRoute(claimsRoute, 'POST', {
      path: '/api/v1/claims',
      as: 'asha',
      body: { title: 'Sneaky total', totalMinor: 1, lineItems: [] },
    });
    expect([post.status, (await httpErrorOf(post)).error.code]).toEqual([422, 'TOTAL_IS_DERIVED']);
    expect(await ownerSql`SELECT count(*)::int AS n FROM claims`).toEqual([{ n: 0 }]);

    const c = await makeDraft('asha', { lines: [{ amountMinor: 120_000 }] });
    for (const key of ['totalMinor', 'total', 'total_minor']) {
      // every total-like spelling (D-28)
      const put = await callRoute(claimRoute, 'PUT', {
        path: `/api/v1/claims/${c.id}`,
        params: { claimId: c.id },
        as: 'asha',
        body: { title: c.title, lineItems: c.lineItems.map(lineInput), [key]: 1 },
      });
      expect([key, put.status, (await httpErrorOf(put)).error.code]).toEqual([
        key,
        422,
        'TOTAL_IS_DERIVED',
      ]);
    }
    expect(await total(c.id)).toBe(120_000);
  });

  it('Prisma: claim.update({ totalMinor }) is refused with UC003', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 120_000 }] });
    await rejects('UC003', () =>
      getDb().claim.update({ where: { id: c.id }, data: { totalMinor: 1 } }),
    ); // P2039
    await rejects('UC003', () =>
      getDb().claim.updateMany({ where: { id: c.id }, data: { totalMinor: 1 } }),
    );
    await rejects(
      'UC003',
      () => getDb().$executeRaw`UPDATE claims SET total_minor = 1 WHERE id = ${c.id}::uuid`,
    ); // P2010
    expect(await total(c.id)).toBe(120_000);
  });

  it('raw SQL: UPDATE claims SET total_minor is refused with UC003', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 120_000 }] });
    await rejects('UC003', () => appSql`UPDATE claims SET total_minor = 999 WHERE id = ${c.id}`);
    await rejects(
      'UC003',
      () => appSql`
        WITH l AS (INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
                   VALUES (${c.id}, ${cat.MEALS}, ${today}, 5, 'cte') RETURNING claim_id)
        UPDATE claims SET total_minor = 7 WHERE id IN (SELECT claim_id FROM l)`,
    ); // the CTE trick
    await rejects('UC003', () => ownerSql`UPDATE claims SET total_minor = 1 WHERE id = ${c.id}`); // a rule, not a privilege
    expect(await total(c.id)).toBe(120_000);
  });

  it('raw SQL: INSERT INTO claims with total_minor ≠ 0 is refused with UC003', async () => {
    const asha = await asPersona('asha');
    await rejects(
      'UC003',
      () => appSql`
        INSERT INTO claims (claimant_id, title, total_minor) VALUES (${asha.id}, 'Born with a total', 500)`,
    );
    await rejects(
      'UC003',
      () => ownerSql`
        INSERT INTO claims (claimant_id, title, total_minor) VALUES (${asha.id}, 'Owner too', 500)`,
    );
    expect(await ownerSql`SELECT count(*)::int AS n FROM claims`).toEqual([{ n: 0 }]);
  });

  it('raw SQL insert, update and delete of lines keep total = Σ lines', async () => {
    const c = await makeDraft('asha'); // empty draft, total 0
    await insertLine(appSql, c.id, 100);
    await expectInSync(c.id);
    await insertLine(appSql, c.id, 250);
    await expectInSync(c.id);
    await appSql`UPDATE line_items SET amount_minor = amount_minor * 2 WHERE claim_id = ${c.id}`;
    await expectInSync(c.id);
    expect(await total(c.id)).toBe(700);
    await appSql`UPDATE line_items SET description = 'text only' WHERE claim_id = ${c.id}`;
    await expectInSync(c.id);
    await appSql`DELETE FROM line_items WHERE claim_id = ${c.id} AND amount_minor = 200`;
    await expectInSync(c.id);
    expect(await total(c.id)).toBe(500);
    await appSql`DELETE FROM line_items WHERE claim_id = ${c.id}`;
    expect(await total(c.id)).toBe(0);
  });

  it('bulk INSERT … SELECT, COPY FROM STDIN and MERGE keep total = Σ lines', async () => {
    const c = await makeDraft('asha');
    await appSql`
      INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
      SELECT ${c.id}, ${cat.MEALS}, ${today}, g * 10, 'bulk ' || g FROM generate_series(1, 1000) g`; // 1,000 rows, one statement
    expect(await total(c.id)).toBe(5_005_000);

    const app = await appClient(); // COPY runs the same statement triggers
    const copy = app.query(
      copyFrom(
        'COPY line_items (claim_id, category_id, expense_date, amount_minor, description) FROM STDIN',
      ),
    );
    copy.end(
      `${c.id}\t${cat.MEALS}\t${today}\t700\tcopied\n${c.id}\t${cat.MEALS}\t${today}\t300\tcopied\n`,
    );
    await finished(copy);
    expect(await total(c.id)).toBe(5_006_000);

    const [first] = await appSql<{ id: string; amount_minor: number }>`
      SELECT id, amount_minor FROM line_items WHERE claim_id = ${c.id} ORDER BY id LIMIT 1`;
    await appSql`
      MERGE INTO line_items li
      USING (VALUES (${first!.id}::uuid, 0), (NULL::uuid, 4242)) AS v(id, amount) ON li.id = v.id
      WHEN MATCHED AND v.amount = 0 THEN DELETE
      WHEN MATCHED THEN UPDATE SET amount_minor = v.amount
      WHEN NOT MATCHED THEN INSERT (claim_id, category_id, expense_date, amount_minor, description)
                            VALUES (${c.id}, ${cat.MEALS}, ${today}, v.amount, 'merged')`; // delete + insert, one statement
    await expectInSync(c.id);
    expect(await total(c.id)).toBe(5_006_000 - first!.amount_minor + 4242);
  });

  it('Prisma createMany, updateMany and deleteMany keep total = Σ lines', async () => {
    const c = await makeDraft('asha');
    await getDb().lineItem.createMany({
      data: [1, 2, 3].map((n) => ({
        claimId: c.id,
        categoryId: cat.MEALS!,
        expenseDate: new Date(`${today}T00:00:00Z`),
        amountMinor: n * 100,
        description: `prisma ${n}`,
      })),
    });
    expect(await total(c.id)).toBe(600);
    await getDb().lineItem.updateMany({ where: { claimId: c.id }, data: { amountMinor: 50 } });
    expect(await total(c.id)).toBe(150);
    await getDb().lineItem.deleteMany({ where: { claimId: c.id } });
    expect(await total(c.id)).toBe(0);
  });

  it('moving a line to another claim is refused with UC010', async () => {
    const a = await makeDraft('asha', { lines: [{ amountMinor: 300 }] });
    const b = await makeDraft('asha', { lines: [{ amountMinor: 700 }] });
    const lineId = a.lineItems[0]!.id;
    await rejects(
      'UC010',
      () => appSql`UPDATE line_items SET claim_id = ${b.id} WHERE id = ${lineId}`,
    );
    await rejects('UC010', () =>
      getDb().lineItem.update({ where: { id: lineId }, data: { claimId: b.id } }),
    );
    expect([await total(a.id), await total(b.id)]).toEqual([300, 700]);
  });

  it('cascade delete of a draft does not trip the guard', async () => {
    const a = await makeDraft('asha', { lines: [{ amountMinor: 300 }, { amountMinor: 400 }] });
    const res = await callRoute(claimRoute, 'DELETE', {
      path: `/api/v1/claims/${a.id}`,
      params: { claimId: a.id },
      as: 'asha',
    });
    expect(res.status).toBe(204);
    const b = await makeDraft('asha', { lines: [{ amountMinor: 500 }] });
    await appSql`DELETE FROM claims WHERE id = ${b.id}`; // raw cascade as the app role
    expect(await ownerSql`SELECT count(*)::int AS n FROM line_items`).toEqual([{ n: 0 }]);
    expect(await ownerSql`SELECT count(*)::int AS n FROM claims`).toEqual([{ n: 0 }]);
  });

  it('owner sabotage: with the recompute trigger disabled, COMMIT fails with UC009', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 100 }] });
    const owner = await ownerClient();
    await rejects('UC009', () =>
      tx(owner, async () => {
        await owner.query(
          'ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert',
        );
        await insertLine(owner.sql, c.id, 50); // stored total stays 100, lines now sum to 150 …
      }),
    ); // … and the deferred check refuses the COMMIT
    expect(await total(c.id)).toBe(100); // the insert AND the DISABLE rolled back together
    expect(await sumOf(c.id)).toBe(100);
    // assertGuardsEnabled (afterEach) proves the trigger is enabled again
  });

  it('50 lines at the per-line cap exceed the claim cap and return 422, never 500', async () => {
    const c = await makeDraft('asha');
    const maxLine = {
      expenseDate: today,
      categoryId: cat.MEALS,
      amountMinor: 100_000_000,
      description: 'Max line',
    };
    const res = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
      body: { title: c.title, lineItems: Array.from({ length: 50 }, () => maxLine) }, // ₹50 crore > ₹1 crore cap
    });
    expect(res.status).toBe(422);
    expect((await httpErrorOf(res)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [expect.objectContaining({ path: ['lineItems'] })] },
    });
    const bulk = (n: number) => appSql`
      INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
      SELECT ${c.id}, ${cat.MEALS}, ${today}, 100000000, 'cap' FROM generate_series(1, ${n}::int)`;
    const [overCap, overflow] = [await errorOf(() => bulk(11)), await errorOf(() => bulk(22))]; // 1.1e9 > CHECK; 2.2e9 > int4
    expect([readSqlState(overCap), readSqlState(overflow)]).toEqual(['23514', '22003']); // the DB backstops fail closed …
    expect([mapError(overCap).code, mapError(overflow).code]).toEqual([
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
    ]); // … as 422
    expect([mapError(overCap).status, mapError(overflow).status]).toEqual([422, 422]);
    expect(await total(c.id)).toBe(0);

    // Exactly at the cap is fine: 10 × ₹10 lakh = ₹1 crore
    const atCap = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
      body: { title: c.title, lineItems: Array.from({ length: 10 }, () => maxLine) },
    });
    expect(atCap.status).toBe(200);
    expect(await total(c.id)).toBe(1_000_000_000);
  });

  it('v_claim_total_drift is empty after every case', async () => {
    const drift = () => ownerSql`SELECT * FROM v_claim_total_drift`;
    const c = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }, { amountMinor: 2_000 }] });
    expect(await drift()).toEqual([]);
    const put = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
      body: {
        title: c.title,
        lineItems: [
          lineInput(c.lineItems[0]!),
          { ...lineInput(c.lineItems[1]!), id: undefined, amountMinor: 9 },
        ],
      },
    });
    expect(put.status).toBe(200);
    expect(await drift()).toEqual([]); // replace-set: one kept, one deleted, one created
    await insertLine(appSql, c.id, 7);
    expect(await drift()).toEqual([]);
    await rejects('UC003', () => appSql`UPDATE claims SET total_minor = 0 WHERE id = ${c.id}`);
    expect(await drift()).toEqual([]);
    expect(await total(c.id)).toBe(c.lineItems[0]!.amountMinor + 9 + 7);
    // the app role reads the view too (pnpm verify:integrity runs as expense_app)
    expect(await appSql`SELECT * FROM v_claim_total_drift`).toEqual([]);
  });
});
