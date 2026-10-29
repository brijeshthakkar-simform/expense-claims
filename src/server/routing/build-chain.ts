import 'server-only';
import { AppError } from '@/server/errors/app-error';
import type { ApproverResolver, ResolvedVia, UserRole } from '@/shared/enums';

// 02 §4: the routing engine as one pure function. No I/O, no clock, no randomness, inputs never
// mutated: identical inputs give deep-equal chains, so TC-U03 needs no database. There is no
// `if (amount > X)` anywhere: the rule is a filter over policy rows (D-19).

export type { ResolvedVia };

/** One approval_policy_tiers row. */
export interface PolicyTier {
  level: number;
  code: string;
  label: string;
  /** The tier applies iff totalMinor > this (exclusive lower bound, paise). */
  appliesAboveMinor: number;
  resolver: ApproverResolver;
  /** REPORTING_LINE only, 1..5. */
  levelsUp: number | null;
  /** DESIGNATED_USER only. */
  designatedUserId: string | null;
  isActive: boolean;
}

export interface OrgUser {
  id: string;
  managerId: string | null;
  isActive: boolean;
  canApprove: boolean;
  role: UserRole;
}

export interface OrgLookup {
  get(id: string): OrgUser | undefined;
  readonly fallbackApproverId: string | null;
}

/** One approval_steps row to insert; the tier fields are copied so in-flight chains never change. */
export interface PlannedStep {
  level: number;
  tierCode: string;
  tierLabel: string;
  appliesAboveMinor: number;
  approverId: string;
  resolvedVia: ResolvedVia;
}

/** Escalation walk cap (also the CTE depth in users.repo loadRoutingRows). */
export const MAX_HOPS = 25;

/**
 * chain = every ACTIVE tier with totalMinor > appliesAboveMinor, in level order, each resolved to
 * one distinct eligible person: primary → the primary's managers upward → the fallback approver.
 * No eligible candidate for a tier → 422 ROUTING_UNRESOLVABLE {tierCode, level}; a tier is never
 * dropped and nothing is ever auto-approved.
 */
export function buildChain(input: {
  tiers: readonly PolicyTier[];
  claimant: OrgUser;
  org: OrgLookup;
  totalMinor: number;
}): PlannedStep[] {
  const { tiers, claimant, org, totalMinor } = input;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1)
    throw new Error('buildChain: totalMinor must be a positive integer');

  const applicable = tiers
    .filter((t) => t.isActive && totalMinor > t.appliesAboveMinor) // ← the entire routing rule
    .sort((a, b) => a.level - b.level); // filter() copied the array; input order is irrelevant

  const chosen = new Set<string>();
  return applicable.map((tier) => {
    for (const cand of candidates(primaryCandidate(tier, claimant, org), org)) {
      if (isEligible(org.get(cand.id), claimant.id, chosen)) {
        chosen.add(cand.id);
        return {
          level: tier.level,
          tierCode: tier.code,
          tierLabel: tier.label,
          appliesAboveMinor: tier.appliesAboveMinor,
          approverId: cand.id,
          resolvedVia: cand.via,
        };
      }
    }
    throw new AppError(
      'ROUTING_UNRESOLVABLE',
      `No eligible approver for the ${tier.label} step. Ask an administrator to fix the reporting line.`,
      { tierCode: tier.code, level: tier.level },
    );
  });
}

/** REPORTING_LINE: the claimant's levelsUp-th manager on the chart as it is (null if too short). */
function primaryCandidate(tier: PolicyTier, claimant: OrgUser, org: OrgLookup): string | null {
  if (tier.resolver === 'DESIGNATED_USER') return tier.designatedUserId;
  let cur: OrgUser | undefined = claimant;
  for (let i = 0; i < (tier.levelsUp ?? 0); i++) {
    if (!cur?.managerId) return null;
    cur = org.get(cur.managerId); // eligibility is judged later, not while walking
  }
  return cur?.id ?? null;
}

/** primary → the primary's managers upward (cycle-safe, capped) → the fallback approver. */
function* candidates(
  primaryId: string | null,
  org: OrgLookup,
): Generator<{ id: string; via: ResolvedVia }> {
  const seen = new Set<string>();
  let id = primaryId;
  for (let hops = 0; id !== null && !seen.has(id) && hops <= MAX_HOPS; hops++) {
    seen.add(id);
    yield { id, via: hops === 0 ? 'PRIMARY' : 'ESCALATED' };
    id = org.get(id)?.managerId ?? null;
  }
  const fb = org.fallbackApproverId;
  if (fb !== null && !seen.has(fb)) yield { id: fb, via: 'FALLBACK' };
}

/**
 * Active, can approve, not FINANCE (duplicates CHECK users_finance_cannot_approve on purpose), not
 * the claimant, and not already in this chain (N tiers = N distinct signatures).
 */
function isEligible(
  u: OrgUser | undefined,
  claimantId: string,
  chosen: ReadonlySet<string>,
): boolean {
  return (
    !!u &&
    u.isActive &&
    u.canApprove &&
    u.role !== 'FINANCE' &&
    u.id !== claimantId &&
    !chosen.has(u.id)
  );
}
