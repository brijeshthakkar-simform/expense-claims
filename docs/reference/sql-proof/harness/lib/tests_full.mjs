// Full state = all five migrations. Every attack runs as expense_app unless it says "owner".
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { group, test, eq, assert, rejects, tx, connect, appUrl, ownerUrl, suUrl, waitUntilBlocked, pidOf, sleep } from './harness.mjs';
import {
  seedReference, createClaim, addLines, claimRow, lineSum, drift, buildSnapshot, buildChain, submit, approve, reject,
  recall, approveAll, recordEvent, addReceipt, todayIst, reqId,
} from './fixtures.mjs';

export async function runFull(db) {
  const owner = await connect(ownerUrl(db), 'full-owner');
  const app = await connect(appUrl(db), 'full-app');
  const app2 = await connect(appUrl(db), 'full-app2');
  const app3 = await connect(appUrl(db), 'full-app3');
  const mon = await connect(suUrl(db), 'full-monitor');
  const { users: U, cats } = await seedReference(owner);

  // helpers ---------------------------------------------------------------------------------
  const draft = async (lines = [{ amount: 1000 }], who = U.asha, title) => {
    const cl = await createClaim(app, who, title);
    const ls = lines.length ? await addLines(app, cl.id, cats, lines) : [];
    return { ...(await claimRow(app, cl.id)), lines: ls };
  };
  const submitted = async (lines = [{ amount: 800000 }], who = U.asha) => {
    const cl = await draft(lines, who);
    const r = await submit(app, cl.id, who);
    return { ...(await claimRow(app, cl.id)), lines: cl.lines, ...r };
  };
  const approved = async (lines = [{ amount: 800000 }], who = U.asha) => {
    const cl = await submitted(lines, who);
    await approveAll(app, cl.id);
    return { ...(await claimRow(app, cl.id)), lines: cl.lines };
  };
  const noDrift = async () => { const d = await drift(app); eq(d.length, 0, 'v_claim_total_drift rows'); };
  const steps = async (claimId) => (await app.query(
    `SELECT s.* FROM approval_steps s JOIN claims c ON c.id = s.claim_id WHERE c.id = $1 ORDER BY s.created_at, s.level`, [claimId])).rows;

  // ===========================================================================================
  group('a. claim total always equals SUM(line items)');

  await test('A1', 'insert one line → total = amount', async () => {
    const c = await draft([{ amount: 12345 }]);
    eq(c.total_minor, 12345, 'total'); await noDrift();
  });
  await test('A2', 'multi-row INSERT (createMany shape) → one recompute, total = sum', async () => {
    const c = await draft([{ amount: 100 }, { amount: 250 }, { amount: 4000 }]);
    eq(c.total_minor, 4350, 'total'); await noDrift();
  });
  await test('A3', 'UPDATE amount; UPDATE description only; UPDATE all lines of a claim', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }]);
    await app.query('UPDATE line_items SET amount_minor = 999 WHERE id = $1', [c.lines[0].id]);
    eq((await claimRow(app, c.id)).total_minor, 1199, 'after amount update');
    await app.query(`UPDATE line_items SET description = 'Renamed line' WHERE id = $1`, [c.lines[1].id]);
    eq((await claimRow(app, c.id)).total_minor, 1199, 'after description update');
    await app.query('UPDATE line_items SET amount_minor = amount_minor * 2 WHERE claim_id = $1', [c.id]);
    eq((await claimRow(app, c.id)).total_minor, 2398, 'after bulk update'); await noDrift();
  });
  await test('A4', 'DELETE one line; DELETE all lines → 0', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }]);
    await app.query('DELETE FROM line_items WHERE id = $1', [c.lines[0].id]);
    eq((await claimRow(app, c.id)).total_minor, 200, 'after one delete');
    await app.query('DELETE FROM line_items WHERE claim_id = $1', [c.id]);
    eq((await claimRow(app, c.id)).total_minor, 0, 'after delete all'); await noDrift();
  });
  await test('A5', 'PUT replace-set in ONE transaction (deleteMany → updateMany → createMany → title) → total = sum', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }, { amount: 300 }]);
    await tx(app, async () => {
      await app.query('SELECT id FROM claims WHERE id = $1 AND claimant_id = $2 FOR NO KEY UPDATE', [c.id, U.asha]);
      await app.query('DELETE FROM line_items WHERE claim_id = $1 AND id <> ALL($2::uuid[])', [c.id, [c.lines[0].id, c.lines[1].id]]);
      const r = await app.query('UPDATE line_items SET amount_minor = 150 WHERE id = $1 AND claim_id = $2', [c.lines[0].id, c.id]);
      eq(r.rowCount, 1, 'updateMany count');
      await addLines(app, c.id, cats, [{ amount: 5000 }, { amount: 7 }]);
      await app.query(`UPDATE claims SET title = 'Client visit Mumbai' WHERE id = $1`, [c.id]);
    });
    eq((await claimRow(app, c.id)).total_minor, 150 + 200 + 5000 + 7, 'total'); await noDrift();
  });
  await test('A6', 'INSERT … ON CONFLICT DO UPDATE (upsert) → total = sum', async () => {
    const c = await draft([{ amount: 100 }]);
    await app.query(
      `INSERT INTO line_items (id, claim_id, category_id, expense_date, amount_minor, description)
       VALUES ($1, $2, $3, '2026-10-01', 777, 'upserted'), (uuidv7(), $2, $3, '2026-10-02', 23, 'new one')
       ON CONFLICT (id) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`, [c.lines[0].id, c.id, cats.MEALS]);
    eq((await claimRow(app, c.id)).total_minor, 800, 'total'); await noDrift();
  });
  await test('A7', 'MERGE (update + delete + insert in one statement) → total = sum', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }]);
    await app.query(
      `MERGE INTO line_items t
       USING (VALUES ($1::uuid, 111), ($2::uuid, 0), (uuidv7(), 333)) AS s(id, amt)
          ON t.id = s.id
        WHEN MATCHED AND s.amt = 0 THEN DELETE
        WHEN MATCHED THEN UPDATE SET amount_minor = s.amt
        WHEN NOT MATCHED THEN INSERT (id, claim_id, category_id, expense_date, amount_minor, description)
             VALUES (s.id, $3, $4, '2026-10-03', s.amt, 'merged in')`, [c.lines[0].id, c.lines[1].id, c.id, cats.MEALS]);
    eq((await claimRow(app, c.id)).total_minor, 444, 'total'); await noDrift();
  });
  await test('A8', 'COPY line_items FROM STDIN as the app role → triggers fire, total = sum', async () => {
    const c = await draft([]);
    const rows = [`${c.id}\t${cats.MEALS}\t2026-10-01\t1500\tcopied one`, `${c.id}\t${cats.MEALS}\t2026-10-02\t2500\tcopied two`].join('\n') + '\n';
    await pipeline(Readable.from([rows]), app.query(copyFrom('COPY line_items (claim_id, category_id, expense_date, amount_minor, description) FROM STDIN')));
    eq((await claimRow(app, c.id)).total_minor, 4000, 'total'); await noDrift();
  });
  await test('A9', 'total over the ₹1 crore cap fails closed (23514); int4 overflow fails closed (22003); claim unchanged', async () => {
    const c = await draft([{ amount: 100000000 }]);
    const tenMore = Array.from({ length: 10 }, () => ({ amount: 100000000 }));
    const a = await rejects('23514', () => addLines(app, c.id, cats, tenMore));
    const twentyFive = Array.from({ length: 25 }, () => ({ amount: 100000000 }));
    const b = await rejects('22003', () => addLines(app, c.id, cats, twentyFive));
    eq((await claimRow(app, c.id)).total_minor, 100000000, 'total intact'); await noDrift();
    return `${a.slice(0, 70)} | ${b.slice(0, 50)}`;
  });
  await test('A10', 'DELETE a never-submitted draft with lines (and a receipt) → cascades cleanly', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }]);
    await addReceipt(app, c.id, c.lines[0].id, U.asha);
    const r = await app.query('DELETE FROM claims WHERE id = $1', [c.id]);
    eq(r.rowCount, 1, 'deleted');
    eq((await app.query('SELECT count(*)::int AS n FROM line_items WHERE claim_id = $1', [c.id])).rows[0].n, 0, 'lines gone');
    await noDrift();
  });
  await test('A11', 'sabotage: owner disables the recompute trigger and inserts a line → COMMIT fails UC009, trigger re-enabled', async () => {
    const c = await draft([{ amount: 100 }]);
    const r = await rejects('UC009', () => tx(owner, async () => {
      await owner.query('ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert');
      await owner.query(`INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description) VALUES ($1, $2, '2026-10-01', 50, 'sabotage')`, [c.id, cats.MEALS]);
    }));
    eq((await owner.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'line_items_20_recompute_after_insert'`)).rows[0].tgenabled, 'O', 'enabled');
    return r;
  });
  await test('A12', 'INSERT claims with total_minor ≠ 0 → UC003 (app and owner)', async () => {
    const a = await rejects('UC003', () => app.query(`INSERT INTO claims (claimant_id, title, total_minor) VALUES ($1, 'Born with a total', 999)`, [U.asha]));
    await rejects('UC003', () => owner.query(`INSERT INTO claims (claimant_id, title, total_minor) VALUES ($1, 'Born with a total', 999)`, [U.asha]));
    return a;
  });

  // ===========================================================================================
  group('b. direct writes of claims.total_minor are rejected (UC003)');

  await test('B1', 'app: UPDATE claims SET total_minor = 1 → UC003', async () => {
    const c = await draft([{ amount: 500 }]);
    const r = await rejects('UC003', () => app.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [c.id]));
    eq((await claimRow(app, c.id)).total_minor, 500, 'intact'); return r;
  });
  await test('B2', 'owner: same UPDATE → UC003 (the guard is not privilege-based)', async () => {
    const c = await draft([{ amount: 500 }]);
    return rejects('UC003', () => owner.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [c.id]));
  });
  await test('B3', 'CTE trick: WITH (INSERT line) UPDATE claims SET total_minor → UC003', async () => {
    const c = await draft([{ amount: 500 }]);
    return rejects('UC003', () => app.query(
      `WITH x AS (INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description)
                  VALUES ($1, $2, '2026-10-01', 5, 'cte line') RETURNING claim_id)
       UPDATE claims SET total_minor = 999999 WHERE id = (SELECT claim_id FROM x)`, [c.id, cats.MEALS]));
  });
  await test('B4', 'a custom GUC grants no authority: set_config(app.recalc, on) then UPDATE → UC003', async () => {
    const c = await draft([{ amount: 500 }]);
    return rejects('UC003', () => tx(app, async () => {
      await app.query(`SELECT set_config('app.recalc', 'on', true)`);
      await app.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [c.id]);
    }));
  });
  await test('B5', 'writing total_minor on a SUBMITTED or APPROVED claim → UC003 / UC001', async () => {
    const s = await submitted();
    const a = await rejects('UC003', () => app.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [s.id]));
    const p = await approved();
    const b = await rejects('UC001', () => app.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [p.id]));
    return `${a.slice(0, 30)} | ${b.slice(0, 30)}`;
  });

  // ===========================================================================================
  group('c. moving a line to another claim is rejected (UC010)');

  await test('C1', 'app: UPDATE line_items SET claim_id = other draft → UC010; both totals intact', async () => {
    const a = await draft([{ amount: 100 }]); const b = await draft([{ amount: 200 }]);
    const r = await rejects('UC010', () => app.query('UPDATE line_items SET claim_id = $1 WHERE id = $2', [b.id, a.lines[0].id]));
    eq((await claimRow(app, a.id)).total_minor, 100, 'a'); eq((await claimRow(app, b.id)).total_minor, 200, 'b'); await noDrift();
    return r;
  });
  await test('C2', 'owner: same move → UC010', async () => {
    const a = await draft([{ amount: 100 }]); const b = await draft([{ amount: 200 }]);
    return rejects('UC010', () => owner.query('UPDATE line_items SET claim_id = $1 WHERE id = $2', [b.id, a.lines[0].id]));
  });
  await test('C3', 'moving a receipt to another line or claim → UC010 (owner; the app has no UPDATE on receipts → 42501)', async () => {
    const a = await draft([{ amount: 100 }, { amount: 5 }]);
    const r = await addReceipt(app, a.id, a.lines[0].id, U.asha);
    const x = await rejects('42501', () => app.query('UPDATE receipts SET line_item_id = $1 WHERE id = $2', [a.lines[1].id, r.id]));
    const y = await rejects('UC010', () => owner.query('UPDATE receipts SET line_item_id = $1 WHERE id = $2', [a.lines[1].id, r.id]));
    return `${x.slice(0, 40)} | ${y.slice(0, 40)}`;
  });

  // ===========================================================================================
  group('d. concurrency under READ COMMITTED (two+ app connections, real interleavings)');

  const pid1 = await pidOf(app);
  const pid2 = await pidOf(app2);
  const pid3 = await pidOf(app3);

  await test('D1', 'T1 insert, T2 insert (blocks), T1 commit, T2 commit → total = sum, no UC009/deadlock', async () => {
    const c = await draft([]);
    await app.query('BEGIN'); await addLines(app, c.id, cats, [{ amount: 100 }]);
    await app2.query('BEGIN'); const p = addLines(app2, c.id, cats, [{ amount: 200 }]); p.catch(() => {});
    const w = await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT'); await p; await app2.query('COMMIT');
    eq((await claimRow(app, c.id)).total_minor, 300, 'total'); await noDrift();
    return `T2 waited (${w}); total 300`;
  });
  await test('D2', 'T1 insert, T2 insert (blocks), T1 ROLLBACK → T2 proceeds; total = T2 only', async () => {
    const c = await draft([]);
    await app.query('BEGIN'); await addLines(app, c.id, cats, [{ amount: 100 }]);
    await app2.query('BEGIN'); const p = addLines(app2, c.id, cats, [{ amount: 200 }]); p.catch(() => {});
    await waitUntilBlocked(mon, pid2);
    await app.query('ROLLBACK'); await p; await app2.query('COMMIT');
    eq((await claimRow(app, c.id)).total_minor, 200, 'total'); await noDrift();
  });
  await test('D3', 'concurrent UPDATE vs DELETE of the SAME line: T1 update, T2 delete (blocks), T1 commit, T2 commit', async () => {
    const c = await draft([{ amount: 100 }, { amount: 1000 }]);
    await app.query('BEGIN'); await app.query('UPDATE line_items SET amount_minor = 150 WHERE id = $1', [c.lines[0].id]);
    await app2.query('BEGIN'); const p = app2.query('DELETE FROM line_items WHERE id = $1', [c.lines[0].id]); p.catch(() => {});
    const w = await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT'); const r = await p; await app2.query('COMMIT');
    eq(r.rowCount, 1, 'deleted after EPQ re-check');
    eq((await claimRow(app, c.id)).total_minor, 1000, 'total'); await noDrift();
    return `T2 waited (${w}); line deleted; total 1000`;
  });
  await test('D4', 'concurrent DELETE (T1) vs UPDATE (T2) of the same line → T2 updates 0 rows; total consistent', async () => {
    const c = await draft([{ amount: 100 }, { amount: 1000 }]);
    await app.query('BEGIN'); await app.query('DELETE FROM line_items WHERE id = $1', [c.lines[0].id]);
    await app2.query('BEGIN'); const p = app2.query('UPDATE line_items SET amount_minor = 5 WHERE id = $1', [c.lines[0].id]); p.catch(() => {});
    await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT'); const r = await p; await app2.query('COMMIT');
    eq(r.rowCount, 0, 'updated rows (service would answer LINE_ITEM_NOT_FOUND / CONFLICT)');
    eq((await claimRow(app, c.id)).total_minor, 1000, 'total'); await noDrift();
  });
  await test('D5', 'concurrent UPDATE of different lines of one claim → serialized on the claim; total = sum', async () => {
    const c = await draft([{ amount: 100 }, { amount: 200 }]);
    await app.query('BEGIN'); await app.query('UPDATE line_items SET amount_minor = 111 WHERE id = $1', [c.lines[0].id]);
    await app2.query('BEGIN'); const p = app2.query('UPDATE line_items SET amount_minor = 222 WHERE id = $1', [c.lines[1].id]); p.catch(() => {});
    await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT'); await p; await app2.query('COMMIT');
    eq((await claimRow(app, c.id)).total_minor, 333, 'total'); await noDrift();
  });
  await test('D6', 'insert vs submit — line insert first: submit waits, then snapshots the new line too', async () => {
    const c = await draft([{ amount: 1000 }]);
    await app.query('BEGIN'); await addLines(app, c.id, cats, [{ amount: 500 }]);
    const p = submit(app2, c.id, U.asha); p.catch(() => {});
    await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT'); const { submission } = await p;
    eq(submission.total_minor, 1500, 'snapshot total includes the concurrent line');
    eq(submission.line_item_count, 2, 'line count');
    const row = await claimRow(app, c.id);
    eq([row.status, row.total_minor], ['SUBMITTED', 1500], 'claim'); await noDrift();
  });
  await test('D7', 'insert vs submit — submit first: the line insert waits, then fails UC002 (claim now SUBMITTED)', async () => {
    const c = await draft([{ amount: 1000 }]);
    let release; const gate = new Promise((r) => { release = r; });
    const p = submit(app, c.id, U.asha, { beforeCommit: () => gate }); p.catch(() => {});
    await sleep(150);
    await app2.query('BEGIN'); const ins = addLines(app2, c.id, cats, [{ amount: 500 }]); ins.catch(() => {});
    await waitUntilBlocked(mon, pid2);
    release(); await p;
    const r = await rejects('UC002', () => ins); await app2.query('ROLLBACK');
    eq((await claimRow(app, c.id)).total_minor, 1000, 'total'); await noDrift();
    return r;
  });
  await test('D8', 'storm: 12 connections × 25 random insert/update/delete transactions on 3 claims → no drift, no UC009, no deadlock', async () => {
    const claims = [await draft([{ amount: 100 }]), await draft([{ amount: 100 }]), await draft([{ amount: 100 }])];
    const conns = await Promise.all(Array.from({ length: 12 }, (_, i) => connect(appUrl(db), `storm-${i}`)));
    const errors = {};
    let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    await Promise.all(conns.map(async (cn) => {
      for (let i = 0; i < 25; i++) {
        const cl = claims[Math.floor(rnd() * 3)].id; const op = rnd();
        try {
          await tx(cn, async () => {
            // the service pattern (D-14): lock the claim row FIRST, then touch its lines
            await cn.query('SELECT id FROM claims WHERE id = $1 FOR NO KEY UPDATE', [cl]);
            if (op < 0.45) await addLines(cn, cl, cats, [{ amount: 1 + Math.floor(rnd() * 5000) }, { amount: 1 + Math.floor(rnd() * 50) }]);
            else if (op < 0.8) await cn.query(`UPDATE line_items SET amount_minor = 1 + (amount_minor * 7) % 9000 WHERE id IN (SELECT id FROM line_items WHERE claim_id = $1 ORDER BY random() LIMIT 2)`, [cl]);
            else await cn.query(`DELETE FROM line_items WHERE id IN (SELECT id FROM line_items WHERE claim_id = $1 ORDER BY random() LIMIT 1)`, [cl]);
          });
        } catch (e) { errors[e.code] = (errors[e.code] ?? 0) + 1; }
      }
    }));
    await Promise.all(conns.map((cn) => cn.end()));
    await noDrift();
    for (const c of claims) eq((await claimRow(app, c.id)).total_minor, await lineSum(app, c.id), 'total = sum');
    eq(Object.keys(errors).length, 0, `errors ${JSON.stringify(errors)}`);
    return '300 transactions, 0 errors, drift empty';
  });
  await test('D8b', 'same storm WITHOUT the claim-first lock (raw multi-row UPDATE/DELETE): deadlocks / lock or statement timeouts roll victims back; never UC009, the total never drifts', async () => {
    const claims = [await draft([{ amount: 100 }, { amount: 5 }, { amount: 7 }]), await draft([{ amount: 100 }, { amount: 5 }, { amount: 7 }])];
    const conns = await Promise.all(Array.from({ length: 10 }, (_, i) => connect(appUrl(db), `storm-raw-${i}`)));
    const errors = {};
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    await Promise.all(conns.map(async (cn) => {
      for (let i = 0; i < 20; i++) {
        const cl = claims[Math.floor(rnd() * 2)].id; const op = rnd();
        try {
          await tx(cn, async () => {
            if (op < 0.3) await addLines(cn, cl, cats, [{ amount: 1 + Math.floor(rnd() * 5000) }]);
            else if (op < 0.85) await cn.query(`UPDATE line_items SET amount_minor = 1 + (amount_minor * 7) % 9000 WHERE id IN (SELECT id FROM line_items WHERE claim_id = $1 ORDER BY random() LIMIT 3)`, [cl]);
            else await cn.query(`DELETE FROM line_items WHERE id IN (SELECT id FROM line_items WHERE claim_id = $1 ORDER BY random() LIMIT 1)`, [cl]);
          });
        } catch (e) { errors[e.code] = (errors[e.code] ?? 0) + 1; }
      }
    }));
    await Promise.all(conns.map((cn) => cn.end()));
    await noDrift();
    for (const c of claims) eq((await claimRow(app, c.id)).total_minor, await lineSum(app, c.id), 'total = sum');
    const unexpected = Object.keys(errors).filter((k) => !['40P01', '55P03', '57014'].includes(k));
    eq(unexpected, [], `only availability errors (deadlock / lock timeout / statement timeout → retry, 409 or 503) allowed, got ${JSON.stringify(errors)}`);
    return `errors ${JSON.stringify(errors)} out of 200 tx, never UC009, drift empty — why services lock the claim row first (D-14; D8 had 0 errors)`;
  });
  await test('D9', 'opposite-order multi-claim writers (raw SQL; services never do this) → PG detects the deadlock (40P01), the survivor commits, totals consistent', async () => {
    const a = await draft([{ amount: 1 }]); const b = await draft([{ amount: 1 }]);
    await app.query('BEGIN'); await app2.query('BEGIN');
    await addLines(app, a.id, cats, [{ amount: 10 }]);
    await addLines(app2, b.id, cats, [{ amount: 20 }]);
    const p1 = addLines(app, b.id, cats, [{ amount: 30 }]); p1.catch(() => {});
    await waitUntilBlocked(mon, pid1);
    const p2 = addLines(app2, a.id, cats, [{ amount: 40 }]); p2.catch(() => {});
    const res = await Promise.allSettled([p1, p2]);
    const codes = res.map((r) => (r.status === 'rejected' ? r.reason.code : 'ok'));
    assert(codes.includes('40P01') && codes.includes('ok'), `codes ${codes}`);
    const loser = codes[0] === '40P01' ? app : app2; const winner = loser === app ? app2 : app;
    await loser.query('ROLLBACK'); await winner.query('COMMIT');
    await noDrift();
    return `outcomes ${codes.join(', ')}; the service-layer retry (40P01 ×2) would re-run the loser`;
  });
  await test('D10', 'double-click approve: two connections approve the same PENDING step → exactly one decision, other sees 0 rows', async () => {
    const c = await submitted([{ amount: 800000 }]);
    const [st] = c.steps;
    const run = (cn) => tx(cn, async () => {
      await cn.query(`SELECT c.id FROM claims c WHERE c.id = $1 AND EXISTS (SELECT 1 FROM approval_steps s WHERE s.claim_id = c.id AND s.approver_id = $2 AND s.status = 'PENDING') FOR NO KEY UPDATE OF c`, [c.id, st.approver_id]);
      const r = await cn.query(`UPDATE approval_steps SET status = 'APPROVED' WHERE id = $1 AND status = 'PENDING'`, [st.id]);
      if (r.rowCount === 1) {
        await cn.query(`UPDATE claims SET status = 'APPROVED' WHERE id = $1`, [c.id]);
        await recordEvent(cn, { claimId: c.id, submissionId: st.submission_id, stepId: st.id, revision: 1, type: 'CLAIM_APPROVED', actorId: st.approver_id, actorRole: 'APPROVER', from: 'SUBMITTED', to: 'APPROVED', totalMinor: c.total_minor });
      }
      return r.rowCount;
    });
    const out = await Promise.allSettled([run(app2), run(app3)]);
    const counts = out.map((o) => (o.status === 'fulfilled' ? o.value : o.reason.code)).sort();
    eq(counts, [0, 1], 'one decision');
    eq((await app.query(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1 AND type = 'CLAIM_APPROVED'`, [c.id])).rows[0].n, 1, 'one event');
    return `rowCounts ${counts.join(', ')}`;
  });
  for (const first of ['approve', 'recall']) {
    await test(`D11-${first}`, first === 'approve'
      ? 'approve (L1 of 2) vs recall, approve queued first → serialized: both succeed in order (recall is legal until the final approval); L1 kept in history'
      : 'approve (L1 of 2) vs recall, recall queued first → serialized: approve finds no PENDING step (NOT_IN_YOUR_QUEUE); nothing approved', async () => {
      const c = await submitted([{ amount: 2500000 }]); // 2 levels: ravi, meera
      let release; const gate = new Promise((r) => { release = r; });
      const holder = tx(app3, async () => { await app3.query('SELECT id FROM claims WHERE id = $1 FOR NO KEY UPDATE', [c.id]); await gate; });
      holder.catch(() => {});
      await sleep(50);
      const start = { approve: () => approve(app2, c.id, U.ravi), recall: () => recall(app, c.id, U.asha) };
      const pids = { approve: pid2, recall: pid1 };
      const second = first === 'approve' ? 'recall' : 'approve';
      const p1 = start[first](); p1.catch(() => {}); await waitUntilBlocked(mon, pids[first]);
      const p2 = start[second](); p2.catch(() => {}); await waitUntilBlocked(mon, pids[second]);
      release(); await holder;
      const [r1, r2] = await Promise.allSettled([p1, p2]);
      const row = await claimRow(app, c.id); const st = (await steps(c.id)).map((x) => x.status);
      eq(row.status, 'DRAFT', 'recall always lands (it is legal before the final approval)');
      if (first === 'approve') {
        eq([r1.status, r2.status], ['fulfilled', 'fulfilled'], 'both succeed in order');
        eq(st, ['APPROVED', 'CANCELLED'], 'L1 approval kept in history, L2 cancelled');
      } else {
        eq([r1.status, r2.status, r2.reason?.app], ['fulfilled', 'rejected', 'NOT_IN_YOUR_QUEUE'], 'approve finds no PENDING step');
        eq(st, ['CANCELLED', 'CANCELLED'], 'nothing approved');
      }
      await noDrift();
      return `final DRAFT; steps ${st.join('/')}`;
    });
  }

  await test('D11-final', 'FINAL approve vs recall race (1-step chain), approve queued first → recall loses: DB refuses SUBMITTED-only transition on an APPROVED claim (UC001)', async () => {
    const c = await submitted([{ amount: 800000 }]);
    let release; const gate = new Promise((r) => { release = r; });
    const holder = tx(app3, async () => { await app3.query('SELECT id FROM claims WHERE id = $1 FOR NO KEY UPDATE', [c.id]); await gate; });
    holder.catch(() => {});
    await sleep(50);
    const p1 = approve(app2, c.id, U.ravi); p1.catch(() => {}); await waitUntilBlocked(mon, pid2);
    const p2 = recall(app, c.id, U.asha); p2.catch(() => {}); await waitUntilBlocked(mon, pid1);
    release(); await holder;
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    eq([r1.status, r2.status, r2.reason?.code], ['fulfilled', 'rejected', 'UC001'], 'approve wins, recall refused');
    eq((await claimRow(app, c.id)).status, 'APPROVED', 'final');
    eq((await app.query(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1`, [c.id])).rows[0].n, 2, 'events: SUBMITTED + APPROVED only');
    return 'exactly one wins; the service maps this to 409 CLAIM_LOCKED before reaching the DB';
  });

  await test('D12', 'lock wait beyond lock_timeout → 55P03 (maps to 409 CONFLICT); role default is 5s, shortened here to 300ms', async () => {
    const c = await draft([{ amount: 1 }]);
    await app.query('BEGIN'); await addLines(app, c.id, cats, [{ amount: 2 }]);
    await app2.query(`SET lock_timeout = '300ms'`);
    try { return await rejects('55P03', () => addLines(app2, c.id, cats, [{ amount: 3 }])); }
    finally { await app2.query('RESET lock_timeout'); await app.query('COMMIT'); }
  });

  // ===========================================================================================
  group('e. APPROVED is immutable (UC001); SUBMITTED content is frozen (UC002)');

  const appr = await draft([{ amount: 800000 }, { amount: 200000 }]);
  const apprReceipt = await addReceipt(app, appr.id, appr.lines[0].id, U.asha);
  await submit(app, appr.id, U.asha);
  await approveAll(app, appr.id);
  eq((await claimRow(app, appr.id)).status, 'APPROVED', 'fixture approved');
  const apprReceiptLine = appr.lines[0].id;
  await test('E1', 'APPROVED: INSERT / UPDATE / DELETE line → UC001', async () => {
    const a = await rejects('UC001', () => addLines(app, appr.id, cats, [{ amount: 1 }]));
    await rejects('UC001', () => app.query('UPDATE line_items SET amount_minor = 1 WHERE id = $1', [appr.lines[0].id]));
    await rejects('UC001', () => app.query(`UPDATE line_items SET description = 'tamper' WHERE id = $1`, [appr.lines[0].id]));
    await rejects('UC001', () => app.query('DELETE FROM line_items WHERE id = $1', [appr.lines[1].id]));
    return a;
  });
  await test('E2', 'APPROVED: INSERT / DELETE receipt → UC001', async () => {
    const a = await rejects('UC001', () => addReceipt(app, appr.id, apprReceiptLine, U.asha));
    await rejects('UC001', () => app.query('DELETE FROM receipts WHERE id = $1', [apprReceipt.id]));
    await rejects('UC001', () => owner.query('DELETE FROM receipts WHERE id = $1', [apprReceipt.id]));
    return a;
  });
  await test('E3', 'APPROVED: UPDATE title / status / approved_at, DELETE claim → UC001', async () => {
    const a = await rejects('UC001', () => app.query(`UPDATE claims SET title = 'tampered title' WHERE id = $1`, [appr.id]));
    await rejects('UC001', () => app.query(`UPDATE claims SET status = 'DRAFT' WHERE id = $1`, [appr.id]));
    await rejects('UC001', () => app.query(`UPDATE claims SET approved_at = approved_at - interval '30 days' WHERE id = $1`, [appr.id]));
    await rejects('UC001', () => app.query(`UPDATE claims SET updated_at = now() WHERE id = $1`, [appr.id]));
    await rejects('UC001', () => app.query('DELETE FROM claims WHERE id = $1', [appr.id]));
    return a;
  });
  await test('E4', 'APPROVED: new submission (resubmit an approved claim) → UC001', async () => {
    return rejects('UC001', () => submit(app, appr.id, U.asha));
  });
  await test('E5', 'APPROVED: owner gets the same UC001 (DB rule, not a privilege)', async () => {
    const a = await rejects('UC001', () => owner.query('UPDATE line_items SET amount_minor = 1 WHERE id = $1', [appr.lines[0].id]));
    await rejects('UC001', () => owner.query(`UPDATE claims SET title = 'owner tamper' WHERE id = $1`, [appr.id]));
    return a;
  });
  await test('E6', 'SUBMITTED: line INSERT / UPDATE / DELETE, receipt INSERT, title UPDATE → UC002; DELETE claim → UC017', async () => {
    const s = await submitted([{ amount: 800000 }]);
    const a = await rejects('UC002', () => addLines(app, s.id, cats, [{ amount: 1 }]));
    await rejects('UC002', () => app.query('UPDATE line_items SET amount_minor = 1 WHERE id = $1', [s.lines[0].id]));
    await rejects('UC002', () => app.query('DELETE FROM line_items WHERE id = $1', [s.lines[0].id]));
    await rejects('UC002', () => addReceipt(app, s.id, s.lines[0].id, U.asha));
    await rejects('UC002', () => app.query(`UPDATE claims SET title = 'edited while submitted' WHERE id = $1`, [s.id]));
    const d = await rejects('UC017', () => app.query('DELETE FROM claims WHERE id = $1', [s.id]));
    return `${a.slice(0, 50)} | ${d.slice(0, 40)}`;
  });
  await test('E7', 'snapshot freeze: after the submission row is inserted (claim still DRAFT) line/receipt writes → UC002', async () => {
    const c = await draft([{ amount: 800000 }]);
    const r = await rejects('UC002', () => submit(app, c.id, U.asha, {
      beforeClaimUpdate: async (cn) => { await cn.query('UPDATE line_items SET amount_minor = 1 WHERE id = $1', [c.lines[0].id]); },
    }));
    eq((await claimRow(app, c.id)).status, 'DRAFT', 'rolled back');
    return r;
  });
  await test('E8', 'REJECTED and recalled (DRAFT rev ≥ 1) claims are editable again', async () => {
    const s = await submitted([{ amount: 800000 }]);
    await reject(app, s.id, s.steps[0].approver_id);
    await app.query('UPDATE line_items SET amount_minor = 700000 WHERE id = $1', [s.lines[0].id]);
    const s2 = await submitted([{ amount: 800000 }]);
    await recall(app, s2.id, U.asha);
    await addLines(app, s2.id, cats, [{ amount: 5 }]);
    eq([(await claimRow(app, s.id)).total_minor, (await claimRow(app, s2.id)).total_minor], [700000, 800005], 'totals'); await noDrift();
  });

  // ===========================================================================================
  group('f. a claim with zero line items cannot be submitted (UC004)');

  await test('F1', 'service submit of an empty draft → UC004 (from the snapshot insert)', async () => {
    const c = await draft([]);
    return rejects('UC004', () => submit(app, c.id, U.asha, { chain: () => [] }));
  });
  await test('F2', 'raw status flip to SUBMITTED with zero lines → UC004 (claims_guard)', async () => {
    const c = await draft([]);
    return rejects('UC004', () => app.query(`UPDATE claims SET status = 'SUBMITTED', current_revision = 1 WHERE id = $1`, [c.id]));
  });
  await test('F3', 'empty snapshot for a claim that has lines → UC004', async () => {
    const c = await draft([{ amount: 100 }]);
    return rejects('UC004', () => submit(app, c.id, U.asha, { snapshot: (s) => ({ ...s, lines: [] }) }));
  });
  await test('F4', 'delete the last line inside the submit transaction → blocked by the freeze (UC002), never an empty submission', async () => {
    const c = await draft([{ amount: 100 }]);
    return rejects('UC002', () => submit(app, c.id, U.asha, { beforeClaimUpdate: (cn) => cn.query('DELETE FROM line_items WHERE claim_id = $1', [c.id]) }));
  });

  // ===========================================================================================
  group('g. audit trail: append-only, DB-stamped, complete (UC007 / UC015)');

  const audited = await approved([{ amount: 2500000 }]);
  await test('G1', 'app: UPDATE / DELETE claim_events → 42501; owner → UC007', async () => {
    const a = await rejects('42501', () => app.query(`UPDATE claim_events SET reason = 'x' WHERE claim_id = $1`, [audited.id]));
    await rejects('42501', () => app.query('DELETE FROM claim_events WHERE claim_id = $1', [audited.id]));
    const b = await rejects('UC007', () => owner.query(`UPDATE claim_events SET reason = 'x' WHERE claim_id = $1`, [audited.id]));
    await rejects('UC007', () => owner.query('DELETE FROM claim_events WHERE claim_id = $1', [audited.id]));
    return `${a.slice(0, 45)} | ${b.slice(0, 45)}`;
  });
  await test('G2', 'claim_submissions: app UPDATE/DELETE → 42501; owner → UC007', async () => {
    const a = await rejects('42501', () => app.query(`UPDATE claim_submissions SET total_minor = 1 WHERE claim_id = $1`, [audited.id]));
    await rejects('42501', () => app.query('DELETE FROM claim_submissions WHERE claim_id = $1', [audited.id]));
    await rejects('UC007', () => owner.query(`UPDATE claim_submissions SET total_minor = 1 WHERE claim_id = $1`, [audited.id]));
    return a;
  });
  await test('G3', 'approval_steps: app DELETE → 42501; owner DELETE → UC007', async () => {
    await rejects('42501', () => app.query('DELETE FROM approval_steps WHERE claim_id = $1', [audited.id]));
    return rejects('UC007', () => owner.query('DELETE FROM approval_steps WHERE claim_id = $1', [audited.id]));
  });
  await test('G4', 'app-supplied occurred_at / tx_id are overwritten by the DB (no backdating, no cross-tx attribution)', async () => {
    const c = await submitted([{ amount: 800000 }]);
    const ev = await tx(app, async () => {
      const { rows: [{ now, xid }] } = await app.query(`SELECT now()::text AS now, pg_current_xact_id()::text AS xid`);
      const e = await recordEvent(app, { claimId: c.id, submissionId: c.submission.id, revision: 1, type: 'CLAIM_SUBMITTED', actorId: U.asha,
        actorRole: 'CLAIMANT', from: 'DRAFT', to: 'SUBMITTED', totalMinor: c.total_minor, occurredAt: '2020-01-01T00:00:00Z', txId: 1 });
      return { e, now, xid };
    });
    assert(!ev.e.occurred_at.startsWith('2020'), `occurred_at ${ev.e.occurred_at}`);
    eq(ev.e.tx_id.toString(), ev.xid, 'tx_id = this transaction');
    return `stored occurred_at=${ev.e.occurred_at}, tx_id=${ev.e.tx_id}`;
  });
  await test('G5', 'status change without an event (recall) → COMMIT fails UC015; nothing persisted', async () => {
    const c = await submitted([{ amount: 800000 }]);
    const r = await rejects('UC015', () => recall(app, c.id, U.asha, { event: () => null }));
    eq((await claimRow(app, c.id)).status, 'SUBMITTED', 'rolled back');
    return r;
  });
  await test('G6', 'decision whose event names another actor → UC015 (actor must be the step approver)', async () => {
    const c = await submitted([{ amount: 800000 }]);
    return rejects('UC015', () => approve(app, c.id, c.steps[0].approver_id, { event: (e) => ({ ...e, actorId: U.neha }) }));
  });
  await test('G7', 'submit whose event names a non-claimant actor → UC015', async () => {
    const c = await draft([{ amount: 800000 }]);
    return rejects('UC015', () => submit(app, c.id, U.asha, { event: (e) => ({ ...e, actorId: U.ravi }) }));
  });
  await test('G8', 'non-final approval (STEP_APPROVED) without an event → UC015 (step-level audit)', async () => {
    const c = await submitted([{ amount: 2500000 }]);
    return rejects('UC015', () => approve(app, c.id, c.steps[0].approver_id, { event: () => null }));
  });
  await test('G9', 'an event committed in an EARLIER transaction does not satisfy a later transition → UC015', async () => {
    const c = await submitted([{ amount: 800000 }]);
    await tx(app, () => recordEvent(app, { claimId: c.id, submissionId: c.submission.id, revision: 1, type: 'CLAIM_RECALLED', actorId: U.asha,
      actorRole: 'CLAIMANT', from: 'SUBMITTED', to: 'DRAFT', totalMinor: c.total_minor }));
    return rejects('UC015', () => recall(app, c.id, U.asha, { event: () => null }));
  });
  await test('G10', 'event type must match the transition (CLAIM_SUBMITTED for a resubmit from REJECTED) → UC015', async () => {
    const s = await submitted([{ amount: 800000 }]);
    await reject(app, s.id, s.steps[0].approver_id);
    return rejects('UC015', () => submit(app, s.id, U.asha, { event: (e) => ({ ...e, type: 'CLAIM_SUBMITTED' }) }));
  });
  await test('G11', 'BY DESIGN: the app role may INSERT a stand-alone event (C-16); it is DB-stamped and immutable but changes no state', async () => {
    const c = await draft([{ amount: 100 }]);
    const e = await tx(app, () => recordEvent(app, { claimId: c.id, revision: 0, type: 'CLAIM_APPROVED', actorId: U.ravi, actorRole: 'APPROVER',
      from: 'SUBMITTED', to: 'APPROVED', totalMinor: 100 }));
    eq((await claimRow(app, c.id)).status, 'DRAFT', 'state unchanged');
    return `inserted event ${e.id.slice(0, 8)}… (accepted residual RT-M2: identity is proven by the scoped query, not the DB)`;
  });
  await test('G12', 'happy path writes exactly one event per state-changing request', async () => {
    const { rows } = await app.query(`SELECT type FROM claim_events WHERE claim_id = $1 ORDER BY occurred_at, id`, [audited.id]);
    eq(rows.map((r) => r.type), ['CLAIM_SUBMITTED', 'STEP_APPROVED', 'CLAIM_APPROVED'], 'events');
  });

  // ===========================================================================================
  group('h. the app role cannot switch the guards off');

  await test('H1', 'SET session_replication_role = replica → 42501', () => rejects('42501', () => app.query('SET session_replication_role = replica')));
  await test('H2', 'ALTER TABLE … DISABLE TRIGGER (ALL / one / USER) → 42501 on every guarded table', async () => {
    for (const t of ['claims', 'line_items', 'receipts', 'claim_submissions', 'approval_steps', 'claim_events']) {
      await rejects('42501', () => app.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`));
      await rejects('42501', () => app.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`));
    }
    return rejects('42501', () => app.query('ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert'));
  });
  await test('H3', 'TRUNCATE (line_items, claims, claim_events, claim_submissions) → 42501', async () => {
    for (const t of ['line_items', 'claims', 'claim_events', 'claim_submissions', 'approval_steps', 'receipts', 'users']) await rejects('42501', () => app.query(`TRUNCATE ${t} CASCADE`));
    return '7 tables refused';
  });
  await test('H4', 'CREATE TABLE / FUNCTION / VIEW in public, CREATE SCHEMA, CREATE TEMP TABLE (shadowing) → 42501', async () => {
    const n = [];
    n.push(await rejects('42501', () => app.query('CREATE TABLE public.evil (id int)')));
    n.push(await rejects('42501', () => app.query(`CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'`)));
    n.push(await rejects('42501', () => app.query('CREATE VIEW public.evil_v AS SELECT 1')));
    n.push(await rejects('42501', () => app.query('CREATE SCHEMA evil')));
    n.push(await rejects('42501', () => app.query('CREATE TEMP TABLE line_items (claim_id uuid, amount_minor int)')));
    return n.map((x) => x.slice(7, 60)).join(' / ');
  });
  await test('H5', 'SET ROLE expense_owner / postgres → 42501; ALTER ROLE self SUPERUSER → 42501; GRANT to self has no effect', async () => {
    await rejects('42501', () => app.query('SET ROLE expense_owner'));
    await rejects('42501', () => app.query('SET ROLE postgres'));
    await rejects('42501', () => app.query('ALTER ROLE expense_app SUPERUSER'));
    await rejects('42501', () => app.query('ALTER ROLE expense_app BYPASSRLS'));
    await app.query('GRANT UPDATE ON users TO expense_app').catch(() => {});   // WARNING "no privileges were granted"
    eq((await app.query(`SELECT has_table_privilege('expense_app', 'users', 'UPDATE') AS p`)).rows[0].p, false, 'still no UPDATE on users');
  });
  await test('H6', 'identity / reference / policy tables are read-only for the app (self-promote to FINANCE, re-point a manager, collapse tiers) → 42501', async () => {
    await rejects('42501', () => app.query(`UPDATE users SET role = 'FINANCE', can_approve = false WHERE id = $1`, [U.asha]));
    await rejects('42501', () => app.query(`UPDATE users SET manager_id = $2 WHERE id = $1`, [U.asha, U.neha]));
    await rejects('42501', () => app.query(`UPDATE approval_policy_tiers SET applies_above_minor = 999999999`));
    await rejects('42501', () => app.query(`INSERT INTO categories (code, name, gl_code) VALUES ('X', 'x', '1234')`));
    return rejects('42501', () => app.query(`DELETE FROM departments`));
  });
  await test('H7', 'exhaustive privilege matrix (C-16): every relation in public, every privilege', async () => {
    const expected = {
      users: 'r', departments: 'r', categories: 'r', approval_policy_tiers: 'r',
      sessions: 'arwd', claims: 'arwd', line_items: 'arwd', receipts: 'ard',
      claim_submissions: 'ar', approval_steps: 'arw', claim_events: 'ar', v_claim_total_drift: 'r', _prisma_migrations: '',
    };
    const { rows } = await mon.query(`
      SELECT c.relname, c.relkind,
             concat_ws('', CASE WHEN has_table_privilege('expense_app', c.oid, 'INSERT') THEN 'a' END,
                           CASE WHEN has_table_privilege('expense_app', c.oid, 'SELECT') THEN 'r' END,
                           CASE WHEN has_table_privilege('expense_app', c.oid, 'UPDATE') THEN 'w' END,
                           CASE WHEN has_table_privilege('expense_app', c.oid, 'DELETE') THEN 'd' END) AS dml,
             has_table_privilege('expense_app', c.oid, 'TRUNCATE') OR has_table_privilege('expense_app', c.oid, 'TRIGGER')
               OR has_table_privilege('expense_app', c.oid, 'REFERENCES') OR has_table_privilege('expense_app', c.oid, 'MAINTAIN') AS ddl_like
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p')`);
    const norm = (s) => [...s].sort().join('');
    for (const r of rows) {
      if (!(r.relname in expected)) throw new Error(`relation ${r.relname} missing from the expected matrix`);
      eq(norm(r.dml), norm(expected[r.relname]), `${r.relname} DML`);
      eq(r.ddl_like, false, `${r.relname} TRUNCATE/TRIGGER/REFERENCES/MAINTAIN`);
    }
    eq(rows.length, Object.keys(expected).length, 'relation count');
    const { rows: [sq] } = await mon.query(`SELECT has_sequence_privilege('expense_app', 'claim_number_seq', 'USAGE') AS u, has_sequence_privilege('expense_app', 'claim_number_seq', 'SELECT') AS s, has_sequence_privilege('expense_app', 'claim_number_seq', 'UPDATE') AS w`);
    eq([sq.u, sq.s, sq.w], [true, true, false], 'sequence USAGE, SELECT, no UPDATE (setval)');
    const { rows: [dbp] } = await mon.query(`SELECT has_database_privilege('expense_app', current_database(), 'TEMPORARY') AS t, has_database_privilege('expense_app', current_database(), 'CREATE') AS c, has_schema_privilege('expense_app', 'public', 'CREATE') AS sc`);
    eq([dbp.t, dbp.c, dbp.sc], [false, false, false], 'no TEMP, no CREATE on db or schema');
    await rejects('42501', () => app.query('SELECT * FROM _prisma_migrations'));
    return `${rows.length} relations match; sequence, database and schema privileges match`;
  });
  await test('H8', 'role attributes: app is not superuser/createdb/createrole/bypassrls, NOINHERIT, owns nothing, not in expense_owner; timeouts set', async () => {
    const { rows: [r] } = await mon.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolconfig FROM pg_roles WHERE rolname = 'expense_app'`);
    eq([r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolinherit], [false, false, false, false, false], 'attributes');
    for (const s of ['statement_timeout=15s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=30s']) assert(r.rolconfig.includes(s), `rolconfig has ${s}`);
    const { rows: [o] } = await mon.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'expense_app'`);
    eq(o.n, 0, 'owned relations');
    const { rows: [m] } = await mon.query(`SELECT pg_has_role('expense_app', 'expense_owner', 'MEMBER') AS m`);
    eq(m.m, false, 'member of expense_owner');
    // the same check assertRuntimeRole() runs at boot, executed AS the app role:
    const { rows: [self] } = await app.query(`SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns,
        pg_has_role(current_user, 'expense_owner', 'MEMBER') AS is_owner_member
      FROM pg_roles r WHERE r.rolname = current_user`);
    eq(Object.values(self), [false, false, false, false, false, false], 'assertRuntimeRole() query as the app');
  });

  // ===========================================================================================
  group('i. state machine and approval-step gating');

  await test('I1', 'DRAFT → APPROVED / REJECTED (raw) → UC005', async () => {
    const c = await draft([{ amount: 100 }]);
    const a = await rejects('UC005', () => app.query(`UPDATE claims SET status = 'APPROVED' WHERE id = $1`, [c.id]));
    await rejects('UC005', () => app.query(`UPDATE claims SET status = 'APPROVED', approved_at = now() WHERE id = $1`, [c.id]));
    await rejects('UC005', () => app.query(`UPDATE claims SET status = 'REJECTED' WHERE id = $1`, [c.id]));
    return a;
  });
  await test('I2', 'APPROVED → DRAFT / SUBMITTED / REJECTED → UC001 (terminal)', async () => {
    for (const s of ['DRAFT', 'SUBMITTED', 'REJECTED']) await rejects('UC001', () => app.query(`UPDATE claims SET status = $2 WHERE id = $1`, [appr.id, s]));
  });
  await test('I3', 'REJECTED → APPROVED / DRAFT → UC005', async () => {
    const s = await submitted([{ amount: 800000 }]); await reject(app, s.id, s.steps[0].approver_id);
    await rejects('UC005', () => app.query(`UPDATE claims SET status = 'APPROVED' WHERE id = $1`, [s.id]));
    return rejects('UC005', () => app.query(`UPDATE claims SET status = 'DRAFT' WHERE id = $1`, [s.id]));
  });
  await test('I4', 'SUBMITTED → APPROVED while a step is still PENDING/WAITING (with a matching event) → UC011', async () => {
    const s = await submitted([{ amount: 2500000 }]);
    return rejects('UC011', () => tx(app, async () => {
      await app.query(`UPDATE claims SET status = 'APPROVED' WHERE id = $1`, [s.id]);
      await recordEvent(app, { claimId: s.id, submissionId: s.submission.id, stepId: s.steps[0].id, revision: 1, type: 'CLAIM_APPROVED', actorId: s.steps[0].approver_id, actorRole: 'APPROVER', from: 'SUBMITTED', to: 'APPROVED', totalMinor: s.total_minor });
    }));
  });
  await test('I5', 'SUBMITTED → REJECTED without a REJECTED step → UC011', async () => {
    const s = await submitted([{ amount: 800000 }]);
    return rejects('UC011', () => app.query(`UPDATE claims SET status = 'REJECTED' WHERE id = $1`, [s.id]));
  });
  await test('I6', 'under-approval: ₹75,000 claim submitted with a 1-step chain → UC012', async () => {
    const c = await draft([{ amount: 7500000 }]);
    return rejects('UC012', () => submit(app, c.id, U.asha, { chain: (ch) => ch.slice(0, 1) }));
  });
  await test('I7', 'exclusive thresholds in SQL: ₹10,000.00 → 1 step OK; ₹10,000.01 with 1 step → UC012; with 2 → OK', async () => {
    const a = await draft([{ amount: 1000000 }]);
    const r1 = await submit(app, a.id, U.asha); eq(r1.steps.length, 1, '₹10,000.00 steps');
    const b = await draft([{ amount: 1000001 }]);
    await rejects('UC012', () => submit(app, b.id, U.asha, { chain: (ch) => ch.slice(0, 1) }));
    const r2 = await submit(app, b.id, U.asha); eq(r2.steps.length, 2, '₹10,000.01 steps');
  });
  await test('I8', 'chain shape: tier copy forged (wrong tier_code / threshold) → UC012; level 2 inserted PENDING → UC012', async () => {
    const c = await draft([{ amount: 2500000 }]);
    await rejects('UC012', () => submit(app, c.id, U.asha, { chain: (ch) => ch.map((s) => (s.level === 2 ? { ...s, tierCode: 'L1_MANAGER' } : s)) }));
    await rejects('UC012', () => submit(app, c.id, U.asha, { chain: (ch) => ch.map((s) => (s.level === 2 ? { ...s, appliesAboveMinor: 0 } : s)) }));
    return rejects('UC012', () => submit(app, c.id, U.asha, { chain: (ch) => ch.map((s) => ({ ...s, status: 'PENDING' })) }));
  });
  await test('I9', 'step inserted outside a submit (claim already SUBMITTED) → UC012', async () => {
    const s = await submitted([{ amount: 800000 }]);
    return rejects('UC012', () => app.query(
      `INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label, applies_above_minor, approver_id, resolved_via, status)
       VALUES ($1, $2, 2, 'L2_SKIP_LEVEL', 'x', 1000000, $3, 'PRIMARY', 'WAITING')`, [s.id, s.submission.id, U.meera]));
  });
  await test('I10', 'ineligible approver at insert: the claimant, a FINANCE user, an inactive user → UC008', async () => {
    const c = await draft([{ amount: 800000 }]);
    const a = await rejects('UC008', () => submit(app, c.id, U.asha, { chain: (ch) => [{ ...ch[0], approverId: U.asha }] }));
    await rejects('UC008', () => submit(app, c.id, U.asha, { chain: (ch) => [{ ...ch[0], approverId: U.farah }] }));
    await owner.query('UPDATE users SET is_active = false WHERE id = $1', [U.neha]);
    try { await rejects('UC008', () => submit(app, c.id, U.asha, { chain: (ch) => [{ ...ch[0], approverId: U.neha }] })); }
    finally { await owner.query('UPDATE users SET is_active = true WHERE id = $1', [U.neha]); }
    return a;
  });
  await test('I11', 'eligibility re-checked at decision time: approver demoted mid-chain (can_approve=false, or role FINANCE) → UC008', async () => {
    const s = await submitted([{ amount: 800000 }]);
    await owner.query('UPDATE users SET can_approve = false WHERE id = $1', [U.ravi]);
    let r;
    try { r = await rejects('UC008', () => approve(app, s.id, U.ravi)); }
    finally { await owner.query('UPDATE users SET can_approve = true WHERE id = $1', [U.ravi]); }
    await owner.query(`UPDATE users SET can_approve = false, role = 'FINANCE' WHERE id = $1`, [U.ravi]);
    try { await rejects('UC008', () => approve(app, s.id, U.ravi)); }
    finally { await owner.query(`UPDATE users SET can_approve = true, role = 'EMPLOYEE' WHERE id = $1`, [U.ravi]); }
    return r;
  });
  await test('I12', 'step gating: WAITING → APPROVED → UC005; WAITING → PENDING before the previous level is approved → UC012', async () => {
    const s = await submitted([{ amount: 2500000 }]);
    const l2 = s.steps.find((x) => x.level === 2);
    const a = await rejects('UC005', () => app.query(`UPDATE approval_steps SET status = 'APPROVED' WHERE id = $1`, [l2.id]));
    const b = await rejects('UC012', () => app.query(`UPDATE approval_steps SET status = 'PENDING' WHERE id = $1`, [l2.id]));
    return `${a.slice(0, 40)} | ${b.slice(0, 40)}`;
  });
  await test('I13', 'decided steps are immutable: edit comment / re-decide an APPROVED step → UC006', async () => {
    const st = (await steps(audited.id)).find((x) => x.level === 1);
    await rejects('UC006', () => app.query(`UPDATE approval_steps SET comment = 'edited later' WHERE id = $1`, [st.id]));
    return rejects('UC006', () => app.query(`UPDATE approval_steps SET status = 'REJECTED', rejection_reason = 'changed my mind!' WHERE id = $1`, [st.id]));
  });
  await test('I14', 'open step identity / timestamps immutable: re-point approver_id, backdate activated_at → UC010', async () => {
    const s = await submitted([{ amount: 800000 }]);
    await rejects('UC010', () => app.query(`UPDATE approval_steps SET approver_id = $2 WHERE id = $1`, [s.steps[0].id, U.neha]));
    return rejects('UC010', () => app.query(`UPDATE approval_steps SET activated_at = activated_at - interval '9 days' WHERE id = $1`, [s.steps[0].id]));
  });
  await test('I15', 'recall leaving an open step (claim → DRAFT with PENDING step) → UC012', async () => {
    const s = await submitted([{ amount: 800000 }]);
    return rejects('UC012', () => recall(app, s.id, U.asha, { skipCancel: true }));
  });
  await test('I16', 'reject leaving WAITING steps open → UC011', async () => {
    const s = await submitted([{ amount: 2500000 }]);
    return rejects('UC011', () => reject(app, s.id, s.steps[0].approver_id, 'Missing receipts here', { skipCancel: true }));
  });
  await test('I17', 'submission revision / submitter forged → UC016', async () => {
    const c = await draft([{ amount: 800000 }]);
    const a = await rejects('UC016', () => submit(app, c.id, U.asha, { revision: 2 }));
    await rejects('UC016', () => submit(app, c.id, U.asha, { submittedBy: U.ravi }));
    return a;
  });
  await test('I18', 'forged snapshot (amount, extra/missing line, GL code, category name, claimant, title, receipt key) → UC016', async () => {
    const c = await draft([{ amount: 800000 }, { amount: 100 }]);
    await addReceipt(app, c.id, c.lines[0].id, U.asha);
    const forge = [
      (s) => { s.lines[0].amountMinor += 1; s.lines[1].amountMinor -= 1; return s; },            // same total, different lines
      (s) => { s.lines.push({ ...s.lines[0] }); return s; },
      (s) => { s.lines.pop(); return s; },
      (s) => { s.lines[0].glCode = '9999'; return s; },
      (s) => { s.lines[0].categoryName = 'Something else'; return s; },
      (s) => { s.claimant.name = 'Someone Else'; return s; },
      (s) => { s.title = 'Different title'; return s; },
      (s) => { const l = s.lines.find((x) => x.receipts.length); l.receipts[0].storageKey = 'receipts/other-claim/evidence.pdf'; return s; },
      (s) => { s.lines[1].receipts.push({ receiptId: s.lines[0].receipts[0].receiptId, fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1, sha256: 'b'.repeat(64), storageKey: 'k' }); return s; },
    ];
    for (const f of forge) await rejects('UC016', () => submit(app, c.id, U.asha, { snapshot: (s) => f(structuredClone(s)) }));
    const ok = await submit(app, c.id, U.asha);
    return `${forge.length} forgeries refused; the honest snapshot (with its receipt) is accepted (rev ${ok.submission.revision})`;
  });
  await test('I19', 'claim pointed at ANOTHER claim\'s submission → UC012; step pointing at another claim\'s submission → UC012 (and the composite FK behind it)', async () => {
    const other = await submitted([{ amount: 800000 }]);
    const c = await draft([{ amount: 800000 }]);
    const a = await rejects('UC012', () => submit(app, c.id, U.asha, {
      beforeClaimUpdate: async (cn) => { await cn.query(`UPDATE claims SET status = 'SUBMITTED', current_revision = 1, current_submission_id = $2 WHERE id = $1`, [c.id, other.submission.id]); },
    }));
    const b = await rejects('UC012', () => app.query(
      `INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label, applies_above_minor, approver_id, resolved_via, status)
       VALUES ($1, $2, 1, 'L1_MANAGER', 'x', 0, $3, 'PRIMARY', 'PENDING')`, [c.id, other.submission.id, U.ravi]));
    return `${a.slice(0, 40)} | ${b.slice(0, 60)}`;
  });
  await test('I20', 'happy path ₹75,000: submit → 3 steps [ravi, meera, vikram] → approve ×3 → APPROVED; DB-stamped timestamps', async () => {
    const c = await draft([{ amount: 7500000 }]);
    const { steps: st } = await submit(app, c.id, U.asha);
    eq(st.map((s) => s.approver_id), [U.ravi, U.meera, U.vikram], 'chain');
    await approveAll(app, c.id);
    const row = await claimRow(app, c.id);
    eq(row.status, 'APPROVED', 'status'); assert(row.approved_at && row.submitted_at, 'timestamps');
    eq((await steps(c.id)).map((s) => s.status), ['APPROVED', 'APPROVED', 'APPROVED'], 'steps');
  });
  await test('I21', 'reject → REJECTED (rest CANCELLED) → edit → resubmit (rev 2) builds a NEW chain from the new total; rev-1 history intact', async () => {
    const s = await submitted([{ amount: 3000000 }]);                    // ₹30,000 → 2 steps
    await approve(app, s.id, U.ravi); await reject(app, s.id, U.meera, 'Hotel invoice missing for 3 Oct');
    eq((await steps(s.id)).map((x) => x.status), ['APPROVED', 'REJECTED'], 'rev 1 steps');
    await app.query('UPDATE line_items SET amount_minor = 950000 WHERE id = $1', [s.lines[0].id]);  // ₹9,500 → 1 step
    const r2 = await submit(app, s.id, U.asha);
    eq([r2.submission.revision, r2.steps.length], [2, 1], 'rev 2 chain');
    const row = await claimRow(app, s.id);
    eq([row.status, row.current_revision, row.rejected_at], ['SUBMITTED', 2, null], 'claim');
    eq((await app.query(`SELECT type FROM claim_events WHERE claim_id = $1 ORDER BY occurred_at, id`, [s.id])).rows.map((x) => x.type),
      ['CLAIM_SUBMITTED', 'STEP_APPROVED', 'CLAIM_REJECTED', 'CLAIM_RESUBMITTED'], 'events');
  });
  await test('I22', 'recall after L1 approved (of 2) → open steps CANCELLED, L1 stays APPROVED; claim DRAFT rev 1; edit; resubmit rev 2', async () => {
    const s = await submitted([{ amount: 2500000 }]);
    await approve(app, s.id, U.ravi); await recall(app, s.id, U.asha);
    eq((await steps(s.id)).map((x) => x.status), ['APPROVED', 'CANCELLED'], 'rev 1 steps');
    eq([(await claimRow(app, s.id)).status, (await claimRow(app, s.id)).current_revision], ['DRAFT', 1], 'claim');
    await addLines(app, s.id, cats, [{ amount: 100 }]);
    const r2 = await submit(app, s.id, U.asha);
    eq(r2.submission.revision, 2, 'rev'); eq(r2.steps[0].status, 'PENDING', 'fresh chain');
  });
  await test('I23', 'DELETE: never-submitted draft OK; recalled draft (rev ≥ 1) → UC017', async () => {
    const s = await submitted([{ amount: 800000 }]); await recall(app, s.id, U.asha);
    return rejects('UC017', () => app.query('DELETE FROM claims WHERE id = $1', [s.id]));
  });
  await test('I24', 'routing fixtures (C-15) hold against the DB chain check: Ravi ₹75k → [meera, vikram, deepa FALLBACK]; Vikram ₹8k → [deepa FALLBACK]; T4 activation → 4 steps', async () => {
    const r = await draft([{ amount: 7500000 }], U.ravi);
    const rr = await submit(app, r.id, U.ravi);
    eq(rr.steps.map((s) => [s.approver_id, s.resolved_via]), [[U.meera, 'PRIMARY'], [U.vikram, 'PRIMARY'], [U.deepa, 'FALLBACK']], 'ravi chain');
    const v = await draft([{ amount: 800000 }], U.vikram);
    const vr = await submit(app, v.id, U.vikram);
    eq(vr.steps.map((s) => [s.approver_id, s.resolved_via]), [[U.deepa, 'FALLBACK']], 'vikram chain');
    let thrown = null; try { await buildChain(app, U.vikram, 2500000); } catch (e) { thrown = e.routing; }
    eq(thrown, { tierCode: 'L2_SKIP_LEVEL', level: 2 }, 'vikram ₹25k unresolvable');
    await owner.query(`UPDATE approval_policy_tiers SET is_active = true WHERE code = 'L4_CFO'`);
    try {
      const big = await draft([{ amount: 25000000 }]);
      await rejects('UC012', () => submit(app, big.id, U.asha, { chain: (ch) => ch.slice(0, 3) }));
      const br = await submit(app, big.id, U.asha);
      eq(br.steps.map((s) => s.approver_id), [U.ravi, U.meera, U.vikram, U.deepa], '₹2,50,000 with T4 active');
    } finally { await owner.query(`UPDATE approval_policy_tiers SET is_active = false WHERE code = 'L4_CFO'`); }
  });

  // ===========================================================================================
  group('j. other rules canonical.md says the database enforces');

  await test('J1', 'expense_date after today in Asia/Kolkata → UC014; today (IST) accepted; also on UPDATE', async () => {
    const t = todayIst();
    const tomorrow = new Date(`${t}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const c = await draft([{ amount: 1, date: t }]);
    const r = await rejects('UC014', () => addLines(app, c.id, cats, [{ amount: 1, date: tomorrow.toISOString().slice(0, 10) }]));
    await rejects('UC014', () => app.query('UPDATE line_items SET expense_date = $2 WHERE id = $1', [c.lines[0].id, tomorrow.toISOString().slice(0, 10)]));
    return `${r.slice(0, 80)} (today IST = ${t})`;
  });
  await test('J2', 'inactive category on insert / on category change → UC013; an existing line keeps working', async () => {
    const c = await draft([{ amount: 1 }]);
    const r = await rejects('UC013', () => addLines(app, c.id, cats, [{ amount: 1, cat: 'LEGACY_PER_DIEM' }]));
    await rejects('UC013', () => app.query('UPDATE line_items SET category_id = $2 WHERE id = $1', [c.lines[0].id, cats.LEGACY_PER_DIEM]));
    await owner.query('UPDATE categories SET is_active = false WHERE code = $1', ['TRAINING']);
    try {
      const d = await draft([]);
      await owner.query(`UPDATE categories SET is_active = true WHERE code = 'TRAINING'`);
      await addLines(app, d.id, cats, [{ amount: 5, cat: 'TRAINING' }]);
      await owner.query(`UPDATE categories SET is_active = false WHERE code = 'TRAINING'`);
      await app.query('UPDATE line_items SET amount_minor = 6 WHERE claim_id = $1', [d.id]);   // amount edit on a now-inactive category: allowed
    } finally { await owner.query(`UPDATE categories SET is_active = true WHERE code = 'TRAINING'`); }
    return r;
  });
  await test('J3', 'claim_number: DB-owned, EXP-YYYY-NNNNNN, consecutive for app inserts (no double draw); app-supplied value replaced', async () => {
    const { rows } = await app.query(`INSERT INTO claims (claimant_id, title) VALUES ($1, 'n one'), ($1, 'n two'), ($1, 'n three') RETURNING claim_number`, [U.asha]);
    const nums = rows.map((r) => Number(r.claim_number.split('-')[2]));
    eq([nums[1] - nums[0], nums[2] - nums[1]], [1, 1], 'consecutive');
    assert(/^EXP-\d{4}-\d{6,}$/.test(rows[0].claim_number), 'format');
    const { rows: [f] } = await app.query(`INSERT INTO claims (claimant_id, title, claim_number) VALUES ($1, 'forged number', 'EXP-1999-000001') RETURNING claim_number`, [U.asha]);
    assert(f.claim_number !== 'EXP-1999-000001', 'forged number replaced');
    const fresh = await connect(appUrl(db), 'fresh-session');
    const { rows: [g] } = await fresh.query(`INSERT INTO claims (claimant_id, title, claim_number) VALUES ($1, 'forged in fresh session', 'EXP-2026-999999') RETURNING claim_number`, [U.asha]);
    await fresh.end();
    assert(g.claim_number !== 'EXP-2026-999999', 'forged number replaced (session without currval)');
    return `${rows.map((r) => r.claim_number).join(', ')}; forged → ${f.claim_number}, ${g.claim_number}`;
  });
  await test('J4', 'claims.created_at and the transition timestamps are DB-owned for the app (backdating ignored or UC010)', async () => {
    const { rows: [c] } = await app.query(`INSERT INTO claims (claimant_id, title, created_at) VALUES ($1, 'backdated create', '2020-01-01') RETURNING created_at`, [U.asha]);
    assert(!c.created_at.startsWith('2020'), `created_at ${c.created_at}`);
    const s = await submitted([{ amount: 800000 }]);
    await rejects('UC010', () => app.query(`UPDATE claims SET submitted_at = '2020-01-01' WHERE id = $1`, [s.id]));
    await approve(app, s.id, s.steps[0].approver_id, { claimPatch: `, approved_at = '2020-01-01'` });
    const row = await claimRow(app, s.id);
    assert(!row.approved_at.startsWith('2020'), `approved_at ${row.approved_at}`);
    const st = (await steps(s.id))[0];
    eq(st.decided_at, row.approved_at, 'step decided_at = claim approved_at (one instant per transaction)');
    return `approved_at=${row.approved_at} (app supplied 2020-01-01)`;
  });
  await test('J5', 'owner-run seed CAN supply backdated transition timestamps (SeedClock), still only at legal transitions', async () => {
    const c = await createClaim(owner, U.arjun, 'Seeded September claim');
    await addLines(owner, c.id, cats, [{ amount: 500000, date: '2026-09-20' }]);
    const r = await submit(owner, c.id, U.arjun, { beforeClaimUpdate: () => {} });
    await tx(owner, async () => {
      await owner.query(`UPDATE approval_steps SET status = 'APPROVED', decided_at = '2026-09-30T18:29:30Z' WHERE id = $1`, [r.steps[0].id]);
      await owner.query(`UPDATE claims SET status = 'APPROVED', approved_at = '2026-09-30T18:29:30Z' WHERE id = $1`, [c.id]);
      await recordEvent(owner, { claimId: c.id, submissionId: r.submission.id, stepId: r.steps[0].id, revision: 1, type: 'CLAIM_APPROVED', actorId: r.steps[0].approver_id, actorRole: 'APPROVER', from: 'SUBMITTED', to: 'APPROVED', totalMinor: 500000, occurredAt: '2026-09-30T18:29:30Z' });
    });
    eq((await claimRow(app, c.id)).approved_at, '2026-09-30 18:29:30+00', 'C09 boundary approved_at (2026-09-30 23:59:30 IST)');
  });
  await test('J6', 'immutable claim columns: claimant_id, claim_number, currency, created_at → UC010; pointer moves only on submit → UC010', async () => {
    const c = await draft([{ amount: 1 }]);
    await rejects('UC010', () => app.query('UPDATE claims SET claimant_id = $2 WHERE id = $1', [c.id, U.ravi]));
    await rejects('UC010', () => app.query(`UPDATE claims SET claim_number = 'EXP-2026-123456' WHERE id = $1`, [c.id]));
    await rejects('UC010', () => app.query(`UPDATE claims SET currency = 'USD' WHERE id = $1`, [c.id]));
    await rejects('UC010', () => app.query(`UPDATE claims SET created_at = now() - interval '1 day' WHERE id = $1`, [c.id]));
    return rejects('UC010', () => app.query(`UPDATE claims SET current_revision = 1, current_submission_id = (SELECT id FROM claim_submissions LIMIT 1) WHERE id = $1`, [c.id]));
  });
  await test('J7', 'CHECK backstops (23514/23505): finance+approve, 2nd fallback, uppercase email, amount 0 / > ₹10L, short description/title, date < 2000, short reject reason', async () => {
    await rejects('23514', () => owner.query(`UPDATE users SET can_approve = true WHERE id = $1`, [U.farah]));
    await rejects('23505', () => owner.query(`UPDATE users SET is_fallback_approver = true WHERE id = $1`, [U.ravi]));
    await rejects('23514', () => owner.query(`UPDATE users SET email = 'Asha.Rao@acme.test' WHERE id = $1`, [U.asha]));
    await rejects('23514', () => owner.query(`UPDATE users SET manager_id = id WHERE id = $1`, [U.asha]));
    const c = await draft([]);
    await rejects('23514', () => addLines(app, c.id, cats, [{ amount: 0 }]));
    await rejects('23514', () => addLines(app, c.id, cats, [{ amount: 100000001 }]));
    await rejects('23514', () => addLines(app, c.id, cats, [{ amount: 1, description: '  a ' }]));
    await rejects('23514', () => addLines(app, c.id, cats, [{ amount: 1, date: '1999-12-31' }]));
    await rejects('23514', () => app.query(`UPDATE claims SET title = ' x ' WHERE id = $1`, [c.id]));
    const s = await submitted([{ amount: 800000 }]);
    await rejects('23514', () => reject(app, s.id, s.steps[0].approver_id, 'too short'));
    await rejects('23514', () => owner.query(`INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver, levels_up, designated_user_id) VALUES (9, 'BAD', 'bad', 1, 'REPORTING_LINE', 1, $1)`, [U.deepa]));
    return '11 CHECK / unique backstops fired';
  });
  await test('J8', 'composite FK: a receipt whose claim_id differs from its line\'s claim → 23503', async () => {
    const a = await draft([{ amount: 1 }]); const b = await draft([{ amount: 1 }]);
    return rejects('23503', () => addReceipt(app, b.id, a.lines[0].id, U.asha));
  });
  await test('J9', '/api/health/ready integrity probe (as the app role): zero disabled non-internal triggers in public', async () => {
    const { rows: [r] } = await app.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'D'`);
    eq(r.n, 0, 'disabled triggers');
  });
  await test('J10', 'schema-objects: exact trigger set per table; every public function pins search_path; contract indexes exist', async () => {
    const expected = {
      claims: ['claims_10_guard', 'claims_90_total_consistent', 'claims_95_transition_audited'],
      line_items: ['line_items_10_before_write', 'line_items_20_recompute_after_delete', 'line_items_20_recompute_after_insert', 'line_items_20_recompute_after_update', 'line_items_90_total_consistent'],
      receipts: ['receipts_10_before_write'],
      claim_submissions: ['claim_submissions_00_append_only', 'claim_submissions_10_verify'],
      approval_steps: ['approval_steps_10_guard', 'approval_steps_95_transition_audited'],
      claim_events: ['claim_events_00_guard'],
    };
    const { rows } = await app.query(`SELECT c.relname, array_agg(t.tgname::text ORDER BY t.tgname) AS trg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal GROUP BY c.relname`);
    const got = Object.fromEntries(rows.map((r) => [r.relname, r.trg]));
    eq(Object.keys(got).sort(), Object.keys(expected).sort(), 'tables with triggers');
    for (const [t, list] of Object.entries(expected)) eq(got[t], list, `${t} triggers`);
    const { rows: fns } = await app.query(`SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
    for (const f of fns) assert((f.proconfig ?? []).includes('search_path=pg_catalog, public, pg_temp'), `${f.proname} pins search_path`);
    eq(fns.length, 11, 'function count (10 PL/pgSQL + next_claim_number)');
    const { rows: ix } = await app.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const names = new Set(ix.map((i) => i.indexname));
    for (const n of ['claims_claimant_list_idx', 'claims_finance_list_idx', 'claims_submitted_idx', 'claims_export_idx', 'line_items_claim_idx', 'receipts_line_item_idx',
      'approval_steps_pending_queue_idx', 'approval_steps_one_pending_per_submission', 'approval_steps_approver_history_idx', 'approval_steps_visibility_idx',
      'claim_events_timeline_idx', 'users_one_fallback_approver']) assert(names.has(n), `index ${n}`);
    return `${Object.values(expected).flat().length} triggers, ${fns.length} functions, 12 contract indexes`;
  });
  await test('J11', 'one PENDING step per submission is also a partial UNIQUE index (owner bypassing the guard trigger → 23505)', async () => {
    const s = await submitted([{ amount: 2500000 }]);
    const l2 = s.steps.find((x) => x.level === 2);
    return rejects('23505', () => tx(owner, async () => {
      await owner.query('ALTER TABLE approval_steps DISABLE TRIGGER approval_steps_10_guard');
      await owner.query(`UPDATE approval_steps SET status = 'PENDING', activated_at = now() WHERE id = $1`, [l2.id]);
    }));
  });
  await test('J12', 'final sweep: v_claim_total_drift is empty after the whole suite', async () => { await noDrift(); });
  await test('J13', 'foot-gun documented: SET CONSTRAINTS ALL IMMEDIATE *before* a line write → UC009 at statement end (fail-closed); after the write it just checks early', async () => {
    const c = await draft([{ amount: 1 }]);
    const r = await rejects('UC009', () => tx(app, async () => { await app.query('SET CONSTRAINTS ALL IMMEDIATE'); await addLines(app, c.id, cats, [{ amount: 2 }]); }));
    await tx(app, async () => { await addLines(app, c.id, cats, [{ amount: 2 }]); await app.query('SET CONSTRAINTS ALL IMMEDIATE'); });
    eq((await claimRow(app, c.id)).total_minor, 3, 'total');
    return `${r.slice(0, 60)} — never call SET CONSTRAINTS in app code`;
  });
  await test('J14', 'test-reset recipe (D-42): owner TRUNCATE of the transactional tables succeeds (no row triggers), app works afterwards', async () => {
    await owner.query('TRUNCATE claims, line_items, receipts, claim_submissions, approval_steps, claim_events, sessions');
    const c = await draft([{ amount: 5 }]);
    eq(c.total_minor, 5, 'fresh claim'); await noDrift();
    await submitted([{ amount: 800000 }]); await approved([{ amount: 800000 }]);   // fixtures for the Prisma probe
  });

  for (const c of [owner, app, app2, app3, mon]) await c.end().catch(() => {});
}
