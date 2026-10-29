// TC-I13 (§6-5, §4-e, RT-m10): concurrency can't desynchronise the total (07 §9.3). Writers to
// one claim serialize on its row lock (FOR NO KEY UPDATE, taken by the line trigger or by the
// service first), proven by observing the wait in pg_stat_activity, never by sleeping.
import { expect, it } from 'vitest';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import { withTx } from '@/server/db/tx';
import { todayInBusinessTz } from '@/shared/dates';
import {
  appClient,
  monitorSql,
  ownerSql,
  pidOf,
  waitUntilBlocked,
  type Sql,
} from '../../helpers/db';
import { categoryIds, makeDraft } from '../../helpers/factories';
import { callRoute } from '../../helpers/http';

const today = todayInBusinessTz();
const total = async (id: string) =>
  (await ownerSql<{ t: number }>`SELECT total_minor AS t FROM claims WHERE id = ${id}`)[0]!.t;
const sumOf = async (id: string) =>
  (
    await ownerSql<{ s: number }>`
      SELECT COALESCE(SUM(amount_minor), 0)::int AS s FROM line_items WHERE claim_id = ${id}`
  )[0]!.s;
const insertLine = async (sql: Sql, claimId: string, amount: number) => {
  const cat = await categoryIds();
  return sql`
    INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
    VALUES (${claimId}, ${cat.MEALS}, ${today}, ${amount}, 'raw insert')`;
};

it('a second writer waits on the claim lock (visible in pg_stat_activity) and the final total is 300', async ({
  annotate,
}) => {
  const c = await makeDraft('asha');
  await categoryIds(); // warm the cache: no extra query may sneak in between the two writers
  const [t1, t2] = [await appClient(), await appClient()];
  const [pid1, pid2] = [await pidOf(t1), await pidOf(t2)]; // read BEFORE t2 blocks: a pg Client queues later queries

  await t1.query('BEGIN');
  await insertLine(t1.sql, c.id, 100);
  await t2.query('BEGIN');
  const p = insertLine(t2.sql, c.id, 200);
  p.catch(() => {});

  const waitedOn = await waitUntilBlocked(pid2); // observed, not assumed: wait_event_type = 'Lock'
  expect(waitedOn).toMatch(/^Lock\//);
  // … and it is waiting on T1 specifically
  const [blockers] = await monitorSql<{ blockers: number[] }>`
    SELECT pg_blocking_pids(${pid2}::int) AS blockers`;
  expect(blockers?.blockers).toEqual([pid1]);

  await t1.query('COMMIT'); // the deferred check passes with total 100 …
  await p; // … then T2's recompute reads the committed line 100
  await t2.query('COMMIT');
  expect(await total(c.id)).toBe(300);
  expect(await sumOf(c.id)).toBe(300);
  await annotate(
    'pg_stat_activity evidence (walkthrough)',
    `writer 2 (pid ${pid2}) waited on ${waitedOn}, blocked by pid ${pid1}; final total ${await total(c.id)}`,
  );
});

it('10 parallel PUTs on one claim end with total = Σ lines', async () => {
  const c = await makeDraft('asha', { lines: [{ amountMinor: 100 }] });
  const cat = await categoryIds();
  const put = (n: number) =>
    callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${c.id}`,
      params: { claimId: c.id },
      as: 'asha',
      body: {
        title: c.title,
        lineItems: Array.from({ length: n }, (_, i) => ({
          expenseDate: today,
          categoryId: cat.MEALS,
          amountMinor: 1_000 * (i + 1),
          description: `parallel ${n}.${i}`,
        })),
      },
    });
  const results = await Promise.all(Array.from({ length: 10 }, (_, k) => put(k + 1)));
  for (const r of results) expect([200, 409]).toContain(r.status); // 409 only as CONFLICT after retries
  expect(await total(c.id)).toBe(await sumOf(c.id)); // last write wins; the total always matches it
  const lines = await ownerSql<{ description: string }>`
    SELECT description FROM line_items WHERE claim_id = ${c.id}`;
  const n = lines.length;
  expect(await total(c.id)).toBe((1_000 * n * (n + 1)) / 2); // exactly one PUT's line set survived …
  expect(new Set(lines.map((l) => l.description.split('.')[0]))).toEqual(
    new Set([`parallel ${n}`]),
  ); // … whole
});

it('inserts spanning two claims in opposite order deadlock-retry without drift', async () => {
  const [a, b] = [await makeDraft('asha'), await makeDraft('asha')];
  const cat = await categoryIds();
  let attempts = 0;
  let bothHoldFirstLock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    let n = 0;
    bothHoldFirstLock = () => {
      if (++n === 2) resolve();
    };
  });
  // Raw multi-claim writes that skip the service's claim-first lock (07 §3.4 rule 6): only attack
  // tests write this way. withTx is the app's retry wrapper (40P01 up to twice).
  const writer = (first: string, second: string) =>
    withTx(async (t) => {
      attempts++;
      await t.$executeRaw`
        INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
        VALUES (${first}::uuid, ${cat.MEALS}::uuid, ${today}::date, 10, 'first claim')`;
      bothHoldFirstLock();
      await barrier; // resolved already on the retry
      await t.$executeRaw`
        INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
        VALUES (${second}::uuid, ${cat.MEALS}::uuid, ${today}::date, 10, 'second claim')`;
    });
  await Promise.all([writer(a.id, b.id), writer(b.id, a.id)]); // Postgres kills one with 40P01; withTx re-runs it
  expect(attempts).toBe(3);
  expect([await total(a.id), await total(b.id)]).toEqual([20, 20]);
  expect([await sumOf(a.id), await sumOf(b.id)]).toEqual([20, 20]);
});
