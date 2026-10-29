import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { requireRole, type Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';

// 04 §5.1, C-26: refusal at the point of the query. The visibility predicate rides inside the one
// SELECT that loads the claim, so an out-of-scope row never leaves Postgres; nothing is loaded and
// then filtered, and nothing is hidden in the UI.

/** Step statuses that let an approver read the claim. WAITING and CANCELLED grant nothing. */
export const VISIBLE_STEP_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/**
 * Who may READ a claim: the owner; an approver with a PENDING, APPROVED or REJECTED step of
 * theirs on it (any revision, so a decided approver keeps read-only access); or FINANCE (read-all,
 * including drafts; every write path is owner- or PENDING-step-scoped). The step branch is an
 * EXISTS on approval_steps served by approval_steps_visibility_idx (claim_id, approver_id).
 */
export function claimVisibilityWhere(actor: Actor): Prisma.ClaimWhereInput {
  if (actor.role === 'FINANCE') return {};
  return {
    OR: [
      { claimantId: actor.id },
      {
        approvalSteps: {
          some: { approverId: actor.id, status: { in: [...VISIBLE_STEP_STATUSES] } },
        },
      },
    ],
  };
}

/**
 * The ONLY way to load a claim by id for reading. `null` = refused by Postgres itself (not
 * visible, or no such claim: the caller can't tell, and neither can the client). No tx: reads run
 * on getDb(), after any commit.
 */
export async function findClaimForActor<S extends Prisma.ClaimSelect>(
  actor: Actor,
  claimId: string,
  select: S,
): Promise<Prisma.ClaimGetPayload<{ select: S }> | null> {
  const row = await getDb().claim.findFirst({
    where: { AND: [{ id: claimId }, claimVisibilityWhere(actor)] }, // AND: nothing can widen it
    select,
  });
  return row as Prisma.ClaimGetPayload<{ select: S }> | null;
}

/**
 * The finance list's scope (04 §5.4, D-04): the first conjunct of the finance list's WHERE, never
 * built from input. FINANCE reads every claimant's claims, so the scope is `TRUE`, but only for
 * FINANCE: anyone else gets 403 FORBIDDEN before any SQL exists, so this can never become an
 * unscoped read for another persona even if a caller forgets its role check. (A SQL fragment, not
 * a Prisma where: the list is one hand-written query, see finance.repo.ts.)
 */
export function financeClaimsWhere(actor: Actor): Prisma.Sql {
  requireRole(actor, 'FINANCE');
  return Prisma.sql`TRUE`;
}
