import 'server-only';
import type { Tx } from '@/server/db/tx';
import * as usersRepo from '@/server/repositories/users.repo';
import type { RoutingRow } from '@/server/repositories/users.repo';
import type { OrgLookup, PolicyTier } from '@/server/routing/build-chain';

// 02 §4.3: the org chart buildChain walks. The SQL (one recursive CTE over manager_id) lives in
// users.repo loadRoutingRows; turning its rows into an OrgLookup is pure.

/** Rows → lookup. The fallback is the single is_fallback_approver row (partial unique index). */
export function buildOrgLookup(rows: readonly RoutingRow[]): OrgLookup {
  const byId = new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        managerId: r.managerId,
        isActive: r.isActive,
        canApprove: r.canApprove,
        role: r.role,
      },
    ]),
  );
  const fallbackApproverId = rows.find((r) => r.isFallbackApprover)?.id ?? null;
  return { get: (id) => byId.get(id), fallbackApproverId };
}

/**
 * Inside the submit transaction: the claimant, every active tier's designated user and the fallback
 * approver, plus everyone above them on the chart (as of now: "routed per the org chart as of
 * submit").
 */
export async function loadOrgLookup(
  tx: Tx,
  claimantId: string,
  tiers: readonly PolicyTier[],
): Promise<OrgLookup> {
  const seeds = new Set([claimantId]);
  for (const t of tiers) if (t.isActive && t.designatedUserId) seeds.add(t.designatedUserId);
  return buildOrgLookup(await usersRepo.loadRoutingRows(tx, [...seeds]));
}
