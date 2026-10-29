import 'server-only';
import * as tiersRepo from '@/server/repositories/tiers.repo';
import type { PolicyTier } from '@/server/routing/build-chain';

// 02 §3.3: the policy's shape rules. Checked at seed time, at boot (assertPolicyLoadsWellFormed,
// step 4 of instrumentation.ts), inside submit before buildChain, and in the owner script that
// flips a tier, so a malformed policy can neither be saved nor served.

export class PolicyConfigError extends Error {
  override readonly name = 'PolicyConfigError';
}

/**
 * Active levels are contiguous 1..N, level 1 has threshold 0 (every claim gets a step), thresholds
 * strictly increase (so the applicable tiers are always a prefix), and the resolver columns match
 * the resolver (the same rule as CHECK tiers_resolver_shape, plus levels_up 1..5).
 */
export function assertPolicyWellFormed(tiers: readonly PolicyTier[]): void {
  const active = tiers.filter((t) => t.isActive).sort((a, b) => a.level - b.level);
  if (active.length === 0) throw new PolicyConfigError('no active tiers');
  active.forEach((t, i) => {
    if (t.level !== i + 1) throw new PolicyConfigError('active levels must be contiguous 1..N');
    if (i === 0 && t.appliesAboveMinor !== 0)
      throw new PolicyConfigError('level 1 must apply to every claim (threshold 0)');
    if (i > 0 && t.appliesAboveMinor <= active[i - 1]!.appliesAboveMinor)
      throw new PolicyConfigError('thresholds must strictly increase');
    const shapeOk =
      t.resolver === 'REPORTING_LINE'
        ? t.levelsUp !== null && t.levelsUp >= 1 && t.levelsUp <= 5 && t.designatedUserId === null
        : t.designatedUserId !== null && t.levelsUp === null;
    if (!shapeOk) throw new PolicyConfigError(`tier ${t.code}: resolver columns are inconsistent`);
  });
}

/** Boot check (step 4 of instrumentation.ts): reads the tiers as expense_app (SELECT grant). */
export async function assertPolicyLoadsWellFormed(): Promise<void> {
  assertPolicyWellFormed(await tiersRepo.listAll());
}
