// TC-I16 (§3.2-a/b, §8-1, §7-Q1, RT-M1): the C-13 policy rows and the C-15 cast route real
// submits, end to end (02 §4.5). resetDb() restores the tiers before every test (L4_CFO inactive),
// so a test may flip a tier with owner SQL and leave it.
import { describe, expect, it } from 'vitest';
import { withTx } from '@/server/db/tx';
import * as tiersRepo from '@/server/repositories/tiers.repo';
import { buildChain } from '@/server/routing/build-chain';
import { loadOrgLookup } from '@/server/routing/org-loader';
import { seedDemoClaims } from '../../../prisma/seed-claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { appSql, ownerSql, rejects } from '../../helpers/db';
import {
  approveAs,
  makeDraft,
  memoryStorage,
  submitAs,
  type ClaimDetail,
} from '../../helpers/factories';

/** Submits a fresh single-line claim of `amountMinor` as `who`; returns the detail. */
async function submitted(who: Persona, amountMinor: number): Promise<ClaimDetail> {
  return submitAs(who, await makeDraft(who, { lines: [{ amountMinor }] }));
}
const names = (c: ClaimDetail) => c.approval?.steps.map((s) => s.approver.name.split(' ')[0]);
/** The stored chain, as the DB holds it. */
const storedSteps = (claimId: string) =>
  ownerSql<{
    level: number;
    tier_code: string;
    approver: string;
    resolved_via: string;
    status: string;
  }>`
    SELECT s.level, s.tier_code, split_part(u.email, '.', 1) AS approver, s.resolved_via, s.status
      FROM approval_steps s JOIN users u ON u.id = s.approver_id
     WHERE s.claim_id = ${claimId} ORDER BY s.level`;
const tiers = () =>
  ownerSql<{ code: string; level: number; applies_above_minor: number; is_active: boolean }>`
    SELECT code, level, applies_above_minor, is_active FROM approval_policy_tiers ORDER BY level`;

describe('TC-I16 routing tiers', () => {
  it('₹10,000.00 → [ravi]; ₹10,000.01 → [ravi, meera]; ₹50,000.01 → [ravi, meera, vikram]', async () => {
    const cases: [number, string[]][] = [
      [1_000_000, ['Ravi']],
      [1_000_001, ['Ravi', 'Meera']],
      [5_000_000, ['Ravi', 'Meera']], // ₹50,000.00 is still 2 (exclusive bounds)
      [5_000_001, ['Ravi', 'Meera', 'Vikram']],
    ];
    for (const [amount, chain] of cases) {
      const c = await submitted('asha', amount);
      expect([amount, names(c)]).toEqual([amount, chain]);
      // The response is the stored chain: level 1 PENDING, the rest WAITING, all PRIMARY
      expect(await storedSteps(c.id)).toEqual(
        chain.map((n, i) => ({
          level: i + 1,
          tier_code: ['L1_MANAGER', 'L2_SKIP_LEVEL', 'L3_SENIOR_LEADER'][i],
          approver: n.toLowerCase(),
          resolved_via: 'PRIMARY',
          status: i === 0 ? 'PENDING' : 'WAITING',
        })),
      );
    }
  });

  it('activating L4 via owner SQL routes ₹2,50,000 to [ravi, meera, vikram, deepa] with no code change', async () => {
    // Seeded: L4_CFO present but inactive, so ₹2,50,000 needs 3 signatures
    expect(await tiers()).toEqual([
      { code: 'L1_MANAGER', level: 1, applies_above_minor: 0, is_active: true },
      { code: 'L2_SKIP_LEVEL', level: 2, applies_above_minor: 1_000_000, is_active: true },
      { code: 'L3_SENIOR_LEADER', level: 3, applies_above_minor: 5_000_000, is_active: true },
      { code: 'L4_CFO', level: 4, applies_above_minor: 20_000_000, is_active: false },
    ]);
    const before = await submitted('asha', 25_000_000);
    expect(names(before)).toEqual(['Ravi', 'Meera', 'Vikram']);

    // A data change, the same one `pnpm policy:activate-tier L4_CFO` makes
    await ownerSql`UPDATE approval_policy_tiers SET is_active = true WHERE code = 'L4_CFO'`;

    const after = await submitted('asha', 25_000_000);
    expect(names(after)).toEqual(['Ravi', 'Meera', 'Vikram', 'Deepa']);
    expect(after.approval?.steps[3]).toMatchObject({
      level: 4,
      tierCode: 'L4_CFO',
      tierLabel: 'CFO',
    });
    expect((await storedSteps(after.id))[3]).toEqual({
      level: 4,
      tier_code: 'L4_CFO',
      approver: 'deepa',
      resolved_via: 'PRIMARY', // the tier's designated user, not the fallback
      status: 'WAITING',
    });
    // Exclusive bound: exactly ₹2,00,000.00 stays at 3 steps
    expect(names(await submitted('asha', 20_000_000))).toEqual(['Ravi', 'Meera', 'Vikram']);
    // In-flight chains never change: the claim submitted before the switch keeps its 3 steps
    expect(await storedSteps(before.id)).toHaveLength(3);
  });

  it('only level 1 is PENDING at submit; approving level n activates n+1', async () => {
    // L4 active, so a ₹2,50,000 claim has the longest chain: [ravi, meera, vikram, deepa]
    await ownerSql`UPDATE approval_policy_tiers SET is_active = true WHERE code = 'L4_CFO'`;
    let c = await submitted('asha', 25_000_000);
    const chain = ['ravi', 'meera', 'vikram', 'deepa'] as const;
    /** level → status, and whether activated_at / decided_at are set */
    const shape = async () =>
      await ownerSql<{ level: number; status: string; activated: boolean; decided: boolean }>`
          SELECT level, status::text, activated_at IS NOT NULL AS activated,
                 decided_at IS NOT NULL AS decided
            FROM approval_steps WHERE claim_id = ${c.id} ORDER BY level`;

    // At submit: level 1 PENDING (activated), every later level WAITING and never activated
    expect(await shape()).toEqual([
      { level: 1, status: 'PENDING', activated: true, decided: false },
      { level: 2, status: 'WAITING', activated: false, decided: false },
      { level: 3, status: 'WAITING', activated: false, decided: false },
      { level: 4, status: 'WAITING', activated: false, decided: false },
    ]);

    for (const [i, who] of chain.entries()) {
      const level = i + 1;
      c = await approveAs(who, c);
      const expected = chain.map((_, j) => ({
        level: j + 1,
        status: j < level ? 'APPROVED' : j === level ? 'PENDING' : 'WAITING',
        activated: j <= level,
        decided: j < level,
      }));
      expect([who, await shape()]).toEqual([who, expected]);
      // never more than one PENDING step (approval_steps_one_pending_per_submission)
      expect(expected.filter((s) => s.status === 'PENDING').length).toBe(level < 4 ? 1 : 0);
      expect(c.status).toBe(level < 4 ? 'SUBMITTED' : 'APPROVED');
    }

    // Each level is activated by the decision of the level before it (same transaction, same
    // instant), never earlier
    const rows = await ownerSql<{ level: number; activated_at: Date; decided_at: Date }>`
      SELECT level, activated_at, decided_at FROM approval_steps WHERE claim_id = ${c.id} ORDER BY level`;
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.activated_at.toISOString()).toBe(rows[i - 1]!.decided_at.toISOString());
    const [claim] = await ownerSql<{ approved_at: Date }>`
      SELECT approved_at FROM claims WHERE id = ${c.id}`;
    expect(claim!.approved_at.toISOString()).toBe(rows[3]!.decided_at.toISOString());

    // Out of order is impossible: a WAITING level can't be decided ahead of its turn (403), and
    // the DB refuses a raw WAITING → PENDING jump while the previous level is not APPROVED (UC012)
    const d = await submitted('asha', 7_500_000); // [ravi, meera, vikram]
    await expect(approveAs('vikram', d)).rejects.toMatchObject({ code: 'NOT_IN_YOUR_QUEUE' });
    await expect(approveAs('meera', d)).rejects.toMatchObject({ code: 'NOT_IN_YOUR_QUEUE' });
    await rejects(
      'UC012',
      () =>
        appSql`UPDATE approval_steps SET status = 'PENDING' WHERE claim_id = ${d.id} AND level = 3`,
    );
  });

  it('stored approvers equal buildChain() for every seeded claim', async () => {
    // The integration DB seeds no demo claims (07 §3.1): seed C01–C12 here, through the same
    // real services the compose seed uses (as expense_app, so the DB stamps every timestamp)
    const ids = await seedDemoClaims();
    expect(Object.keys(ids)).toHaveLength(12);
    const [count] = await ownerSql<{ steps: number }>`
      SELECT count(*)::int AS steps FROM approval_steps`;
    expect(count!.steps).toBeGreaterThan(0); // the loop below can't pass over zero rows

    const submissions = await ownerSql<{
      id: string;
      claim_id: string;
      revision: number;
      claimant_id: string;
      total_minor: number;
    }>`
      SELECT s.id, s.claim_id, s.revision, c.claimant_id, s.total_minor
        FROM claim_submissions s JOIN claims c ON c.id = s.claim_id
       ORDER BY c.claim_number, s.revision`;
    // C02–C12 are submitted once each and C06 twice; C01 is a never-submitted draft
    expect(submissions).toHaveLength(12);
    expect(submissions.map((s) => s.claim_id)).not.toContain(ids.C01);

    const key = Object.fromEntries(Object.entries(ids).map(([k, id]) => [id, k]));
    for (const s of submissions) {
      const stored = await ownerSql<{
        level: number;
        tierCode: string;
        approverId: string;
        resolvedVia: string;
      }>`
        SELECT level, tier_code AS "tierCode", approver_id AS "approverId",
               resolved_via AS "resolvedVia"
          FROM approval_steps WHERE submission_id = ${s.id} ORDER BY level`;
      // The routing engine on today's policy rows and org chart (unchanged since the seed ran)
      const planned = await withTx(async (tx) => {
        const tiers = await tiersRepo.listActive(tx);
        const org = await loadOrgLookup(tx, s.claimant_id, tiers);
        return buildChain({
          tiers,
          claimant: org.get(s.claimant_id)!,
          org,
          totalMinor: s.total_minor,
        });
      });
      const label = `${key[s.claim_id]} r${s.revision}`;
      expect([label, stored]).toEqual([
        label,
        planned.map(({ level, tierCode, approverId, resolvedVia }) => ({
          level,
          tierCode,
          approverId,
          resolvedVia,
        })),
      ]);
    }

    // Spot checks against C-15 (02 §4.5), by name: C04 needs three signatures, C06's chain shrank
    // from 2 steps to 1 on resubmit, C11 fell back to deepa
    const chainOf = async (claimId: string) =>
      (
        await ownerSql<{ chain: string }>`
          SELECT s.revision || ':' || string_agg(split_part(u.email, '.', 1), ',' ORDER BY st.level) AS chain
            FROM claim_submissions s
            JOIN approval_steps st ON st.submission_id = s.id
            JOIN users u ON u.id = st.approver_id
           WHERE s.claim_id = ${claimId}
           GROUP BY s.revision ORDER BY s.revision`
      ).map((r) => r.chain);
    expect(await chainOf(ids.C04)).toEqual(['1:ravi,meera,vikram']);
    expect(await chainOf(ids.C06)).toEqual(['1:ravi,meera', '2:ravi']);
    expect(await chainOf(ids.C11)).toEqual(['1:deepa']);

    // C04's one seeded receipt: on line 1 through the real upload (object stored), frozen into
    // revision 1's snapshot by the submit, and locked with the approved claim even for raw SQL
    const c04Receipts = await ownerSql<{ id: string; line_item_id: string; storage_key: string }>`
      SELECT id, line_item_id, storage_key FROM receipts WHERE claim_id = ${ids.C04}`;
    expect(c04Receipts).toHaveLength(1);
    const [receipt] = c04Receipts;
    const [snap] = await ownerSql<{ line: string; receipt: string }>`
      SELECT snapshot #>> '{lines,0,lineItemId}' AS line,
             snapshot #>> '{lines,0,receipts,0,receiptId}' AS receipt
        FROM claim_submissions WHERE claim_id = ${ids.C04} AND revision = 1`;
    expect(snap).toEqual({ line: receipt!.line_item_id, receipt: receipt!.id });
    expect(await memoryStorage().get(receipt!.storage_key)).not.toBeNull();
    await rejects('UC001', () => appSql`DELETE FROM receipts WHERE claim_id = ${ids.C04}`);
  });

  it("vikram's ₹8,000 claim routes to deepa as FALLBACK", async () => {
    const c = await submitted('vikram', 800_000);
    expect(names(c)).toEqual(['Deepa']);
    expect(await storedSteps(c.id)).toEqual([
      {
        level: 1,
        tier_code: 'L1_MANAGER',
        approver: 'deepa',
        resolved_via: 'FALLBACK',
        status: 'PENDING',
      },
    ]);
    const deepa = await asPersona('deepa');
    const [event] = await ownerSql<{ payload: unknown }>`
      SELECT payload FROM claim_events WHERE claim_id = ${c.id}`;
    expect(event?.payload).toEqual({
      lineItemCount: 1,
      chain: [{ level: 1, tierCode: 'L1_MANAGER', approverId: deepa.id, resolvedVia: 'FALLBACK' }],
    });
    // Ravi ₹75,000 → [meera, vikram, deepa (FALLBACK)] (02 §4.5)
    const ravi = await submitted('ravi', 7_500_000);
    expect((await storedSteps(ravi.id)).map((s) => `${s.approver}:${s.resolved_via}`)).toEqual([
      'meera:PRIMARY',
      'vikram:PRIMARY',
      'deepa:FALLBACK',
    ]);
  });

  it('expense_app cannot change approval_policy_tiers', async () => {
    const before = await tiers();
    // Collapse the policy, switch L4 on, add or remove a tier: all refused by the grants (D-35)
    await rejects(
      '42501',
      () => appSql`UPDATE approval_policy_tiers SET is_active = true WHERE code = 'L4_CFO'`,
    );
    await rejects(
      '42501',
      () => appSql`UPDATE approval_policy_tiers SET applies_above_minor = 999999999`,
    );
    await rejects(
      '42501',
      () => appSql`UPDATE approval_policy_tiers SET is_active = false WHERE level > 1`,
    );
    await rejects('42501', () => appSql`DELETE FROM approval_policy_tiers WHERE level > 1`);
    await rejects(
      '42501',
      () => appSql`
        INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver, levels_up)
        VALUES (5, 'L5_EVIL', 'Evil', 1, 'REPORTING_LINE', 1)`,
    );
    await rejects('42501', () => appSql`TRUNCATE approval_policy_tiers`);
    expect(await tiers()).toEqual(before);
    // ...while reading it is allowed (submit and the boot check read the policy as expense_app)
    expect(await appSql`SELECT count(*)::int AS n FROM approval_policy_tiers`).toEqual([{ n: 4 }]);
  });
});
