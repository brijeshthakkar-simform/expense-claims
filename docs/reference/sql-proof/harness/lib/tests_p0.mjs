// P0 state = migrations 0001_init + 0002_integrity_core + 0003_privileges only (claims_guard v1,
// no workflow tables). These are canonical's five spike tests (a)–(e) plus the v1 state-machine edges.
import { group, test, eq, assert, rejects, tx, connect, appUrl, ownerUrl, suUrl, waitUntilBlocked, pidOf } from './harness.mjs';
import { seedReference, createClaim, addLines, claimRow, drift } from './fixtures.mjs';

export async function runP0(db) {
  const owner = await connect(ownerUrl(db), 'p0-owner');
  const app = await connect(appUrl(db), 'p0-app');
  const app2 = await connect(appUrl(db), 'p0-app2');
  const mon = await connect(suUrl(db), 'p0-monitor');
  const { users, cats } = await seedReference(owner, { withTiers: false });

  group('P0 spike (state after 0001–0003, claims_guard v1)');

  await test('P0-a', 'app role raw UPDATE claims SET total_minor raises UC003', async () => {
    const cl = await createClaim(app, users.asha);
    await addLines(app, cl.id, cats, [{ amount: 1500 }]);
    const r = await rejects('UC003', () => app.query('UPDATE claims SET total_minor = 1 WHERE id = $1', [cl.id]));
    eq((await claimRow(app, cl.id)).total_minor, 1500, 'total intact');
    return r;
  });

  await test('P0-b', 'line UPDATE / INSERT / DELETE on a SUBMITTED claim raises UC002 (v1 submit = status flip + revision/pointer bump)', async () => {
    const cl = await createClaim(app, users.asha);
    const [line] = await addLines(app, cl.id, cats, [{ amount: 2000 }]);
    // P0 has no claim_submissions table yet (FK arrives in 0004), so the spike points at a placeholder uuid
    await app.query(`UPDATE claims SET status = 'SUBMITTED', current_revision = 1, current_submission_id = uuidv7() WHERE id = $1`, [cl.id]);
    const a = await rejects('UC002', () => app.query('UPDATE line_items SET amount_minor = 1 WHERE id = $1', [line.id]));
    await rejects('UC002', () => addLines(app, cl.id, cats, [{ amount: 5 }]));
    await rejects('UC002', () => app.query('DELETE FROM line_items WHERE id = $1', [line.id]));
    const row = await claimRow(app, cl.id);
    eq(row.total_minor, 2000, 'total intact');
    assert(row.submitted_at !== null, 'submitted_at stamped by the DB');
    return a;
  });

  await test('P0-c', 'owner disables the recompute trigger inside a tx; COMMIT fails UC009; trigger is enabled again', async () => {
    const cl = await createClaim(app, users.asha);
    await addLines(app, cl.id, cats, [{ amount: 100 }]);
    const r = await rejects('UC009', () => tx(owner, async () => {
      await owner.query('ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert');
      await owner.query(`INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description) VALUES ($1, $2, '2026-10-01', 999, 'sabotage')`, [cl.id, cats.MEALS]);
    }));
    const { rows: [t] } = await owner.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'line_items_20_recompute_after_insert'`);
    eq(t.tgenabled, 'O', 'trigger re-enabled (DDL rolled back with the failed COMMIT)');
    eq((await claimRow(app, cl.id)).total_minor, 100, 'total intact');
    return r;
  });

  await test('P0-d', 'app role cannot DISABLE TRIGGER, TRUNCATE or SET session_replication_role (42501)', async () => {
    const notes = [];
    notes.push(await rejects('42501', () => app.query('SET session_replication_role = replica')));
    notes.push(await rejects('42501', () => app.query('ALTER TABLE line_items DISABLE TRIGGER ALL')));
    notes.push(await rejects('42501', () => app.query('TRUNCATE line_items')));
    return notes.map((n) => n.slice(0, 60)).join(' / ');
  });

  await test('P0-e', 'two connections inserting lines into one claim serialize and the total is 300', async () => {
    const cl = await createClaim(app, users.asha);
    await app.query('BEGIN');
    await addLines(app, cl.id, cats, [{ amount: 100 }]);
    const pid2 = await pidOf(app2);
    await app2.query('BEGIN');
    const p2 = addLines(app2, cl.id, cats, [{ amount: 200 }]);
    p2.catch(() => {});
    const blocked = await waitUntilBlocked(mon, pid2);
    await app.query('COMMIT');
    await p2;
    await app2.query('COMMIT');
    eq((await claimRow(app, cl.id)).total_minor, 300, 'total');
    eq((await drift(app)).length, 0, 'drift rows');
    return `T2 waited on ${blocked}; final total 300`;
  });

  await test('P0-f', 'v1 refuses DRAFT -> APPROVED (UC005) and a zero-line submit (UC004)', async () => {
    const cl = await createClaim(app, users.asha);
    const a = await rejects('UC004', () => app.query(`UPDATE claims SET status = 'SUBMITTED', current_revision = 1, current_submission_id = uuidv7() WHERE id = $1`, [cl.id]));
    await addLines(app, cl.id, cats, [{ amount: 10 }]);
    const b = await rejects('UC005', () => app.query(`UPDATE claims SET status = 'APPROVED', approved_at = now() WHERE id = $1`, [cl.id]));
    return `${a.slice(0, 40)} / ${b.slice(0, 40)}`;
  });

  for (const c of [owner, app, app2, mon]) await c.end();
}
