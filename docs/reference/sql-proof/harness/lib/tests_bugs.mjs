// Evidence that the two SQL defects found in the canonical spec are real: each is reproduced on a
// throw-away database by reverting ONE function to the canonical-as-written behaviour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { group, test, eq, assert, connect, appUrl, ownerUrl, ROOT } from './harness.mjs';
import { seedReference, createClaim, addLines, submit, claimRow } from './fixtures.mjs';

export async function runBugEvidence(db) {
  const owner = await connect(ownerUrl(db), 'bug-owner');
  const app = await connect(appUrl(db), 'bug-app');
  const { users: U, cats } = await seedReference(owner);
  group('Bug evidence: canonical-as-written vs the verified SQL (throw-away database)');

  await test('BUG-1', 'canonical "claims_guard forces claim_number := next_claim_number()" + column DEFAULT next_claim_number() → every app insert burns TWO sequence values', async () => {
    // revert just the claim-number branch to the canonical wording
    const fixed = readFileSync(join(ROOT, 'sql/0004_workflow.post.sql'), 'utf8');
    const start = fixed.indexOf('CREATE OR REPLACE FUNCTION public.claims_guard()');
    const end = fixed.indexOf('$$;', fixed.indexOf('AS $$', start)) + 3;
    let naive = fixed.slice(start, end);
    naive = naive.replace(/BEGIN\s+v_seq := currval[\s\S]*?END IF;\n      NEW\.created_at := v_now;/, 'NEW.claim_number := public.next_claim_number();\n      NEW.created_at := v_now;');
    assert(!naive.includes('currval'), 'patched');
    await owner.query(naive);
    const { rows } = await app.query(`INSERT INTO claims (claimant_id, title) VALUES ($1, 'one'), ($1, 'two'), ($1, 'three') RETURNING claim_number`, [U.asha]);
    const n = rows.map((r) => Number(r.claim_number.split('-')[2]));
    eq([n[1] - n[0], n[2] - n[1]], [2, 2], 'gap between consecutive claims (canonical wording)');
    await owner.query(fixed.slice(start, end));   // restore the verified version
    const { rows: r2 } = await app.query(`INSERT INTO claims (claimant_id, title) VALUES ($1, 'four'), ($1, 'five') RETURNING claim_number`, [U.asha]);
    const m = r2.map((r) => Number(r.claim_number.split('-')[2]));
    eq(m[1] - m[0], 1, 'gap with the verified version');
    return `canonical wording: ${rows.map((r) => r.claim_number).join(', ')}; verified: ${r2.map((r) => r.claim_number).join(', ')}`;
  });

  await test('BUG-2', 'canonical D-18 verifies the snapshot only at INSERT: without the freeze, a line edited after the snapshot (same tx, claim still DRAFT) is submitted with a snapshot that no longer matches', async () => {
    // revert assert_claim_editable to the 0002 (v1) body = canonical C-04 #1 (no freeze)
    const v1 = readFileSync(join(ROOT, 'sql/0002_integrity_core.sql'), 'utf8');
    const s = v1.indexOf('CREATE FUNCTION public.assert_claim_editable');
    const e = v1.indexOf('$$;', v1.indexOf('AS $$', s)) + 3;
    await owner.query(v1.slice(s, e).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    const cl = await createClaim(app, U.asha, 'Snapshot drift demo');
    const [line] = await addLines(app, cl.id, cats, [{ amount: 800000, cat: 'MEALS' }]);
    await submit(app, cl.id, U.asha, {
      beforeClaimUpdate: (c) => c.query('UPDATE line_items SET category_id = $2, description = $3 WHERE id = $1', [line.id, cats.CLIENT_ENTERTAINMENT, 'Changed after the snapshot']),
    });
    const { rows: [x] } = await app.query(
      `SELECT c.status, s.snapshot->'lines'->0->>'categoryCode' AS snap_cat, cat.code AS live_cat
         FROM claims c JOIN claim_submissions s ON s.id = c.current_submission_id
         JOIN line_items li ON li.claim_id = c.id JOIN categories cat ON cat.id = li.category_id WHERE c.id = $1`, [cl.id]);
    eq([x.status, x.snap_cat, x.live_cat], ['SUBMITTED', 'MEALS', 'CLIENT_ENTERTAINMENT'], 'committed with a mismatching snapshot');
    return `committed: status ${x.status}, snapshot says ${x.snap_cat}, live line says ${x.live_cat} (verified SQL refuses this with UC002, tests E7/F4)`;
  });

  await owner.end(); await app.end();
}
