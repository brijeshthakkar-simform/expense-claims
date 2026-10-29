// TC-U03 (§3.2-a/b, §8-1, §7-Q1): the routing engine as a pure function (02 §4). The policy and
// the org chart below are written out from C-13 and C-15 (02 §3.1, §4.5), not read from the code
// under test; one case cross-checks that the seed's constants say the same thing.
import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors/app-error';
import {
  buildChain,
  type OrgLookup,
  type OrgUser,
  type PlannedStep,
  type PolicyTier,
} from '@/server/routing/build-chain';
import { assertPolicyWellFormed, PolicyConfigError } from '@/server/routing/policy';
import { seededPolicy } from '../../prisma/seed-personas';

// ------------------------------------------------------------------------------ C-13 policy

const tier = (
  level: number,
  code: string,
  label: string,
  appliesAboveMinor: number,
  o: Partial<PolicyTier> = {},
): PolicyTier => ({
  level,
  code,
  label,
  appliesAboveMinor,
  resolver: 'REPORTING_LINE',
  levelsUp: level,
  designatedUserId: null,
  isActive: true,
  ...o,
});

/** C-13 as seeded: L1–L3 active, L4_CFO inactive and designated to deepa. */
const POLICY: readonly PolicyTier[] = Object.freeze([
  tier(1, 'L1_MANAGER', 'Line manager', 0),
  tier(2, 'L2_SKIP_LEVEL', 'Skip-level manager', 1_000_000),
  tier(3, 'L3_SENIOR_LEADER', 'Senior leader', 5_000_000),
  tier(4, 'L4_CFO', 'CFO', 20_000_000, {
    resolver: 'DESIGNATED_USER',
    levelsUp: null,
    designatedUserId: 'deepa',
    isActive: false,
  }),
]);

// ------------------------------------------------------------------------------ C-15 org chart

const person = (id: string, managerId: string | null, o: Partial<OrgUser> = {}): OrgUser => ({
  id,
  managerId,
  isActive: true,
  canApprove: true,
  role: 'EMPLOYEE',
  ...o,
});

/** asha → ravi → meera → vikram (top); neha → meera; arjun → neha; deepa → vikram; farah → deepa. */
const CAST: readonly OrgUser[] = [
  person('vikram', null),
  person('admin', null, { role: 'ADMIN', canApprove: false }),
  person('meera', 'vikram'),
  person('deepa', 'vikram'),
  person('ravi', 'meera'),
  person('neha', 'meera'),
  person('asha', 'ravi', { canApprove: false }),
  person('arjun', 'neha', { canApprove: false }),
  person('farah', 'deepa', { role: 'FINANCE', canApprove: false }),
];

function orgOf(users: readonly OrgUser[], fallbackApproverId: string | null = 'deepa'): OrgLookup {
  const byId = new Map(users.map((u) => [u.id, u]));
  return { get: (id) => byId.get(id), fallbackApproverId };
}
/** The cast with some people changed (deactivated, re-pointed, …) or added. */
function castWith(changes: Record<string, Partial<OrgUser>>, extra: OrgUser[] = []): OrgUser[] {
  return [...CAST.map((u) => ({ ...u, ...changes[u.id] })), ...extra];
}

function route(
  claimantId: string,
  totalMinor: number,
  o: { tiers?: readonly PolicyTier[]; users?: readonly OrgUser[]; fallback?: string | null } = {},
): PlannedStep[] {
  const org = orgOf(o.users ?? CAST, o.fallback === undefined ? 'deepa' : o.fallback);
  return buildChain({ tiers: o.tiers ?? POLICY, claimant: org.get(claimantId)!, org, totalMinor });
}
/** `approverId:resolvedVia` per level, the compact form of the 02 §4.5 table. */
const chainOf = (steps: PlannedStep[]) => steps.map((s) => `${s.approverId}:${s.resolvedVia}`);
const approvers = (steps: PlannedStep[]) => steps.map((s) => s.approverId);

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

const withL4Active = (tiers: readonly PolicyTier[]) =>
  tiers.map((t) => (t.code === 'L4_CFO' ? { ...t, isActive: true } : t));

describe('TC-U03 buildChain', () => {
  it('₹10,000.00 routes to 1 step', () => {
    const steps = route('asha', 1_000_000);
    expect(steps).toEqual([
      {
        level: 1,
        tierCode: 'L1_MANAGER',
        tierLabel: 'Line manager',
        appliesAboveMinor: 0,
        approverId: 'ravi',
        resolvedVia: 'PRIMARY',
      },
    ]);
    expect(approvers(route('asha', 1))).toEqual(['ravi']); // ₹0.01: every claim gets a step
    expect(approvers(route('asha', 800_000))).toEqual(['ravi']);
  });

  it('₹10,000.01 routes to 2 steps', () => {
    const steps = route('asha', 1_000_001);
    expect(chainOf(steps)).toEqual(['ravi:PRIMARY', 'meera:PRIMARY']);
    expect(steps[1]).toMatchObject({
      level: 2,
      tierCode: 'L2_SKIP_LEVEL',
      tierLabel: 'Skip-level manager',
      appliesAboveMinor: 1_000_000,
    });
  });

  it('₹50,000.00 routes to 2 steps', () => {
    expect(chainOf(route('asha', 5_000_000))).toEqual(['ravi:PRIMARY', 'meera:PRIMARY']);
    expect(approvers(route('asha', 2_500_000))).toEqual(['ravi', 'meera']);
  });

  it('₹50,000.01 routes to 3 steps', () => {
    const steps = route('asha', 5_000_001);
    expect(chainOf(steps)).toEqual(['ravi:PRIMARY', 'meera:PRIMARY', 'vikram:PRIMARY']);
    expect(steps.map((s) => [s.level, s.tierCode])).toEqual([
      [1, 'L1_MANAGER'],
      [2, 'L2_SKIP_LEVEL'],
      [3, 'L3_SENIOR_LEADER'],
    ]);
    // T4 inactive: ₹2,50,000 still has 3 steps (02 §3.1)
    expect(approvers(route('asha', 25_000_000))).toEqual(['ravi', 'meera', 'vikram']);
  });

  it('activating the L4 tier row yields a 4-step chain with no code change', () => {
    // The seed's constants are C-13 (cross-check, so this test and the DB agree on the policy)
    expect(seededPolicy('deepa')).toEqual(POLICY);
    expect(seededPolicy(null)).toEqual(POLICY.slice(0, 3));

    const active = withL4Active(POLICY); // a data change: one row's is_active, nothing else
    assertPolicyWellFormed(active);
    const steps = route('asha', 25_000_000, { tiers: active });
    expect(chainOf(steps)).toEqual([
      'ravi:PRIMARY',
      'meera:PRIMARY',
      'vikram:PRIMARY',
      'deepa:PRIMARY', // DESIGNATED_USER: deepa is the tier's primary, not the fallback
    ]);
    expect(steps[3]).toMatchObject({
      level: 4,
      tierCode: 'L4_CFO',
      tierLabel: 'CFO',
      appliesAboveMinor: 20_000_000,
    });
    // Exclusive bound: exactly ₹2,00,000.00 stays at 3 steps; one paisa more reaches the CFO
    expect(route('asha', 20_000_000, { tiers: active })).toHaveLength(3);
    expect(route('asha', 20_000_001, { tiers: active })).toHaveLength(4);
    // ...and deactivating the row again goes back to 3
    expect(route('asha', 25_000_000, { tiers: POLICY })).toHaveLength(3);
  });

  it('tier input order does not change the chain', () => {
    const tiers = withL4Active(POLICY);
    const expected = route('asha', 25_000_000, { tiers });
    const orders = [
      [...tiers].reverse(),
      [tiers[2]!, tiers[0]!, tiers[3]!, tiers[1]!],
      [tiers[1]!, tiers[3]!, tiers[0]!, tiers[2]!],
    ];
    for (const order of orders) {
      const frozen = Object.freeze(order.map((t) => Object.freeze({ ...t })));
      expect(route('asha', 25_000_000, { tiers: frozen })).toEqual(expected);
      expect(frozen.map((t) => t.level)).toEqual(order.map((t) => t.level)); // input not re-sorted
    }
    // Same inputs, same output: no clock, no randomness
    expect(route('ravi', 7_500_000)).toEqual(route('ravi', 7_500_000));
  });

  it('skips claimant, FINANCE, inactive and non-approver candidates by escalating upward', () => {
    // Inactive (02 §4.4): with ravi deactivated, Asha's ₹25,000 escalates past him to meera; L2's
    // primary (meera) is then taken, so it escalates again to vikram
    const noRavi = castWith({ ravi: { isActive: false } });
    expect(chainOf(route('asha', 2_500_000, { users: noRavi }))).toEqual([
      'meera:ESCALATED',
      'vikram:ESCALATED',
    ]);

    // FINANCE: never approves, even if a bad row says can_approve (the CHECK is duplicated)
    const fin = person('fin', 'meera', { role: 'FINANCE', canApprove: true });
    const zed = person('zed', 'fin', { canApprove: false });
    expect(chainOf(route('zed', 500_000, { users: castWith({}, [fin, zed]) }))).toEqual([
      'meera:ESCALATED',
    ]);

    // Non-approver: an ADMIN manager without can_approve
    const adm = person('adm', 'vikram', { role: 'ADMIN', canApprove: false });
    const yan = person('yan', 'adm', { canApprove: false });
    expect(chainOf(route('yan', 500_000, { users: castWith({}, [adm, yan]) }))).toEqual([
      'vikram:ESCALATED',
    ]);

    // The claimant: a designated user filing their own claim escalates to their manager
    const deepaTier = [
      tier(1, 'L1_CFO', 'CFO', 0, {
        resolver: 'DESIGNATED_USER',
        levelsUp: null,
        designatedUserId: 'deepa',
      }),
    ];
    expect(chainOf(route('deepa', 500_000, { tiers: deepaTier }))).toEqual(['vikram:ESCALATED']);
    // ...and a cycle in the chart that leads back to the claimant is skipped, never approved
    const cyc = [person('p', 'q'), person('q', 'p')];
    const steps = route('p', 2_500_000, { users: castWith({}, cyc) });
    expect(chainOf(steps)).toEqual(['q:PRIMARY', 'deepa:FALLBACK']);
    expect(approvers(steps)).not.toContain('p');
  });

  it('a person resolved for two tiers is used once; the later tier escalates to the next distinct approver', () => {
    // L2 designated to ravi, who is already Asha's L1: L2 escalates to ravi's manager
    const tiers = [
      tier(1, 'L1_MANAGER', 'Line manager', 0),
      tier(2, 'L2_DESIGNATED', 'Designated', 1_000_000, {
        resolver: 'DESIGNATED_USER',
        levelsUp: null,
        designatedUserId: 'ravi',
      }),
    ];
    const steps = route('asha', 2_500_000, { tiers });
    expect(chainOf(steps)).toEqual(['ravi:PRIMARY', 'meera:ESCALATED']);
    expect(new Set(approvers(steps)).size).toBe(steps.length);

    // Same with the C-13 tiers: ravi inactive makes L1 and L2 both resolve to meera first
    const noRavi = castWith({ ravi: { isActive: false } });
    const big = route('asha', 7_500_000, { users: noRavi });
    expect(approvers(big)).toEqual(['meera', 'vikram', 'deepa']); // N tiers, N distinct people
    expect(big.map((s) => s.resolvedVia)).toEqual(['ESCALATED', 'ESCALATED', 'FALLBACK']);
  });

  it('uses the fallback approver when the reporting line is too short', () => {
    expect(chainOf(route('vikram', 800_000))).toEqual(['deepa:FALLBACK']);
    expect(chainOf(route('ravi', 7_500_000))).toEqual([
      'meera:PRIMARY',
      'vikram:PRIMARY',
      'deepa:FALLBACK',
    ]);
    // Farah (FINANCE, as claimant) ₹3,000 → [deepa], her own manager (02 §4.5)
    expect(chainOf(route('farah', 300_000))).toEqual(['deepa:PRIMARY']);
    // Arjun: [neha] / [neha, meera]
    expect(approvers(route('arjun', 500_000))).toEqual(['neha']);
    expect(approvers(route('arjun', 2_500_000))).toEqual(['neha', 'meera']);
  });

  it('throws ROUTING_UNRESOLVABLE when no eligible candidate exists', () => {
    // Vikram ₹25,000: no second-level manager and the fallback is already his L1 (deliberate fixture)
    const err = thrown(() => route('vikram', 2_500_000));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'ROUTING_UNRESOLVABLE',
      status: 422,
      details: { tierCode: 'L2_SKIP_LEVEL', level: 2 },
    });
    // Deepa (the fallback) filing ₹25,000: her line has one manager and the fallback is herself
    expect(thrown(() => route('deepa', 2_500_000))).toMatchObject({
      code: 'ROUTING_UNRESOLVABLE',
      details: { tierCode: 'L2_SKIP_LEVEL', level: 2 },
    });
    // Meera ₹75,000 (02 §4.4)
    expect(thrown(() => route('meera', 7_500_000))).toMatchObject({
      code: 'ROUTING_UNRESOLVABLE',
      details: { tierCode: 'L3_SENIOR_LEADER', level: 3 },
    });
    // No fallback configured: Vikram's ₹8,000 can't route at all; a tier is never dropped
    expect(thrown(() => route('vikram', 800_000, { fallback: null }))).toMatchObject({
      code: 'ROUTING_UNRESOLVABLE',
      details: { tierCode: 'L1_MANAGER', level: 1 },
    });
  });

  it('assertPolicyWellFormed rejects gaps, non-increasing thresholds and a level 1 threshold above 0', () => {
    const [l1, l2, l3, l4] = POLICY as [PolicyTier, PolicyTier, PolicyTier, PolicyTier];
    const rejectsWith = (tiers: PolicyTier[], message: string | RegExp) => {
      const err = thrown(() => assertPolicyWellFormed(tiers));
      expect(err).toBeInstanceOf(PolicyConfigError);
      expect((err as Error).message).toMatch(message);
    };

    // Accepted: the seeded policy, with L4 inactive or active, in any input order
    expect(() => assertPolicyWellFormed(POLICY)).not.toThrow();
    expect(() => assertPolicyWellFormed(withL4Active(POLICY).reverse())).not.toThrow();
    expect(() => assertPolicyWellFormed([l1])).not.toThrow();

    // Gaps among the ACTIVE levels (an inactive L2 leaves 1, 3)
    rejectsWith([l1, { ...l2, isActive: false }, l3], /contiguous/);
    rejectsWith([l1, l3], /contiguous/);
    rejectsWith([l2, l3], /contiguous/); // no level 1 at all
    // Non-increasing thresholds: equal, then decreasing
    rejectsWith([l1, { ...l2, appliesAboveMinor: 0 }], /strictly increase/);
    rejectsWith([l1, l2, { ...l3, appliesAboveMinor: 1_000_000 }], /strictly increase/);
    rejectsWith([l1, l2, { ...l3, appliesAboveMinor: 999_999 }], /strictly increase/);
    rejectsWith([l1, l2, l3, { ...l4, isActive: true, appliesAboveMinor: 100 }], /increase/);
    // Level 1 must apply to every claim
    rejectsWith([{ ...l1, appliesAboveMinor: 1 }, l2], /threshold 0/);
    // No active tier, or resolver columns that disagree with the resolver
    rejectsWith([{ ...l1, isActive: false }], /no active tiers/);
    rejectsWith([{ ...l1, levelsUp: null }], /resolver columns/);
    rejectsWith([{ ...l1, levelsUp: 6 }], /resolver columns/);
    rejectsWith([{ ...l1, designatedUserId: 'deepa' }], /resolver columns/);
    rejectsWith([l1, l2, l3, { ...l4, isActive: true, levelsUp: 1 }], /resolver columns/);
    rejectsWith([l1, l2, l3, { ...l4, isActive: true, designatedUserId: null }], /resolver/);
  });
});
