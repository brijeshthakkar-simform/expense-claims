import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';
import type { PolicyTier } from '@/server/routing/build-chain';

// approval_policy_tiers (D-19). expense_app has SELECT only (C-16): the policy changes through
// migrations or the owner script `pnpm policy:activate-tier`, never through the app's credentials.

const SELECT = {
  level: true,
  code: true,
  label: true,
  appliesAboveMinor: true,
  resolver: true,
  levelsUp: true,
  designatedUserId: true,
  isActive: true,
} satisfies Prisma.ApprovalPolicyTierSelect;

/** Every tier, active or not, in level order (the boot check and the owner script). */
export function listAll(tx?: Tx): Promise<PolicyTier[]> {
  return (tx ?? getDb()).approvalPolicyTier.findMany({ orderBy: { level: 'asc' }, select: SELECT });
}

/** The active tiers, in level order: the routing input for a submit (inside its transaction). */
export function listActive(tx: Tx): Promise<PolicyTier[]> {
  return tx.approvalPolicyTier.findMany({
    where: { isActive: true },
    orderBy: { level: 'asc' },
    select: SELECT,
  });
}
