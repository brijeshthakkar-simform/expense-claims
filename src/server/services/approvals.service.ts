import 'server-only';
import { recordEvent } from '@/server/audit/record-event';
import { requireRole, type Actor } from '@/server/auth/actor';
import { withTx, type Tx } from '@/server/db/tx';
import { AppError } from '@/server/errors/app-error';
import { logEvent } from '@/server/logging/logger';
import * as claimsRepo from '@/server/repositories/claims.repo';
import { expectOne, type LockedClaim } from '@/server/repositories/claims.repo';
import * as stepsRepo from '@/server/repositories/steps.repo';
import type { MyPendingStep, QueueRow } from '@/server/repositories/steps.repo';
import { getClaim } from '@/server/services/claims.service';
import type { ServiceCtx } from '@/server/services/context';
import { CursorError, decodeCursor, encodeCursor, type CursorFilters } from '@/shared/cursor';
import { businessDayRangeToUtc } from '@/shared/dates';
import type { ApprovalTask } from '@/shared/dto/approvals';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ApproveInput, RejectInput } from '@/shared/schemas/claims';
import type { ApprovalQueueQuery } from '@/shared/schemas/queries';

// Decisions and the approver queue (02 §8–§9, 04 §5.3, C-25, C-26). Every function is
// (ctx, ...ids, input?). The role gate (canApprove && role ≠ FINANCE) runs before any query, here
// as well as in defineRoute, so finance never opens a transaction. A decision then runs in one
// withTx: the PENDING-scoped claim lock first, my step re-read with a fresh statement, the revision
// pin, count-checked writes, one recordEvent; the DB re-proves eligibility (UC008), the chain
// (UC012), completeness (UC011) and the audit row (UC015) before COMMIT. withTx retries
// 40001/40P01/P2034 twice, then 409 CONFLICT.

/**
 * The C-25 decision prefix: lock the claim through MY PENDING step, re-read that step, check the
 * revision. No row (or no step after the fresh read) is diagnosed without an existence oracle:
 * 409 ALREADY_DECIDED only for someone who decided the current revision (and can read it anyway),
 * otherwise the same 403 NOT_IN_YOUR_QUEUE for a random id, another approver's claim, a WAITING
 * step, a recalled or superseded revision.
 */
async function lockMyPendingStep(
  tx: Tx,
  actor: Actor,
  claimId: string,
  revision: number,
): Promise<{ claim: LockedClaim; step: MyPendingStep }> {
  const claim = await claimsRepo.lockClaimRoutedToMe(tx, actor, claimId);
  const step =
    claim?.currentSubmissionId != null
      ? await stepsRepo.findMyPendingStep(tx, actor, claim.currentSubmissionId)
      : null;
  if (!claim || !step) {
    throw (await stepsRepo.didIDecideCurrentRevision(tx, actor, claimId))
      ? new AppError('ALREADY_DECIDED')
      : new AppError('NOT_IN_YOUR_QUEUE');
  }
  if (revision !== claim.currentRevision)
    throw new AppError('REVISION_MISMATCH', undefined, {
      requestedRevision: revision,
      currentRevision: claim.currentRevision,
    });
  return { claim, step };
}

/**
 * POST /api/v1/claims/:claimId/approve, in the C-25 order: role gate → lockClaimRoutedToMe → my
 * PENDING step → revision → step PENDING → APPROVED (+ comment) → next level WAITING → PENDING
 * (STEP_APPROVED) or claim SUBMITTED → APPROVED (CLAIM_APPROVED) → COMMIT → log → fresh detail.
 */
export async function approve(
  ctx: ServiceCtx,
  claimId: string,
  input: ApproveInput,
): Promise<ClaimDetail> {
  const { actor } = ctx;
  requireRole(actor, 'APPROVER'); // 403 FORBIDDEN before any query (self-guarding, D-04)
  const at = ctx.clock?.now(); // owner-run seed only (02 §9)
  const comment = input.comment ? input.comment : null; // '' (after trim) = no comment
  const done = await withTx(async (tx) => {
    const { claim, step } = await lockMyPendingStep(tx, actor, claimId, input.revision);
    expectOne(await stepsRepo.approveStep(tx, actor, step.id, { comment, at }));

    const base = {
      claimId: claim.id,
      submissionId: step.submissionId,
      stepId: step.id,
      revision: claim.currentRevision,
      totalMinor: claim.totalMinor, // = the submission total: lines are frozen while SUBMITTED
      reason: comment ?? undefined,
    };
    const decision = { level: step.level, levelCount: step.levelCount, tierCode: step.tierCode };

    const next = await stepsRepo.findByLevel(tx, step.submissionId, step.level + 1);
    if (next) {
      expectOne(await stepsRepo.activateStep(tx, next.id, at));
      await recordEvent(tx, ctx, {
        ...base,
        type: 'STEP_APPROVED',
        payload: { ...decision, nextApproverId: next.approverId },
      });
      return { event: 'claim.step_approved' as const, revision: claim.currentRevision, step };
    }

    expectOne(await claimsRepo.markApproved(tx, claim.id, { submissionId: step.submissionId, at }));
    await recordEvent(tx, ctx, {
      ...base,
      type: 'CLAIM_APPROVED',
      payload: {
        ...decision,
        approverIds: await stepsRepo.approverIdsInOrder(tx, step.submissionId),
      },
    });
    return { event: 'claim.approved' as const, revision: claim.currentRevision, step };
  });

  logEvent(done.event, {
    claimId,
    revision: done.revision,
    level: done.step.level,
    levelCount: done.step.levelCount,
  });
  return getClaim(ctx, claimId);
}

/**
 * POST /api/v1/claims/:claimId/reject, in the C-25 order: as approve up to the revision check →
 * step PENDING → REJECTED (+ reason) → later WAITING steps → CANCELLED → claim SUBMITTED →
 * REJECTED → recordEvent(CLAIM_REJECTED) → COMMIT → log → fresh detail.
 */
export async function reject(
  ctx: ServiceCtx,
  claimId: string,
  input: RejectInput,
): Promise<ClaimDetail> {
  const { actor } = ctx;
  requireRole(actor, 'APPROVER');
  const at = ctx.clock?.now();
  const done = await withTx(async (tx) => {
    const { claim, step } = await lockMyPendingStep(tx, actor, claimId, input.revision);
    expectOne(await stepsRepo.rejectStep(tx, actor, step.id, { reason: input.reason, at }));
    const cancelledStepIds = await stepsRepo.cancelWaiting(tx, step.submissionId, at);
    if (cancelledStepIds.length !== step.levelCount - step.level)
      throw new AppError('CONFLICT', 'The claim changed concurrently. Please retry.', {
        retryable: true,
      }); // every later level must have been WAITING (unreachable under the lock)
    expectOne(await claimsRepo.markRejected(tx, claim.id, { submissionId: step.submissionId, at }));
    await recordEvent(tx, ctx, {
      type: 'CLAIM_REJECTED',
      claimId: claim.id,
      submissionId: step.submissionId,
      stepId: step.id,
      revision: claim.currentRevision,
      totalMinor: claim.totalMinor,
      reason: input.reason,
      payload: {
        level: step.level,
        levelCount: step.levelCount,
        tierCode: step.tierCode,
        cancelledStepIds,
      },
    });
    return { revision: claim.currentRevision, step, cancelled: cancelledStepIds.length };
  });

  logEvent('claim.rejected', {
    claimId,
    revision: done.revision,
    level: done.step.level,
    levelCount: done.step.levelCount,
    cancelledSteps: done.cancelled,
  });
  return getClaim(ctx, claimId);
}

// ------------------------------------------------------------------------------------ queue

/** The fixed sorts of GET /approvals, bound into every cursor they issue. */
export const QUEUE_SORT = { PENDING: 'activatedAt:asc', DECIDED: 'decidedAt:desc' } as const;

export interface ApprovalTaskPageResult {
  items: ApprovalTask[];
  nextCursor: string | null;
  limit: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toApprovalTask(r: QueueRow): ApprovalTask {
  // CHECK steps_activated: a PENDING, APPROVED or REJECTED step always has activated_at.
  if (!r.activatedAt)
    throw new Error(`approval step ${r.stepId} is listed but was never activated`);
  return {
    stepId: r.stepId,
    claimId: r.claimId,
    claimNumber: r.claimNumber,
    title: r.title,
    claimant: { id: r.claimantId, name: r.claimantName },
    revision: r.revision,
    level: r.level,
    levelCount: r.levelCount,
    tierLabel: r.tierLabel,
    amountMinor: r.amountMinor,
    currency: r.currency,
    status: r.status,
    activatedAt: r.activatedAt.toISOString(),
    decidedAt: iso(r.decidedAt),
  };
}

/**
 * GET /api/v1/approvals: my PENDING steps oldest first (default), or my decided steps newest first
 * (`status` = APPROVED and/or REJECTED). Keyset-paginated; `from`/`to` filter the tab's own date
 * column. Never lists WAITING or CANCELLED steps, or anyone else's.
 */
export async function listQueue(
  ctx: ServiceCtx,
  query: ApprovalQueueQuery,
): Promise<ApprovalTaskPageResult> {
  requireRole(ctx.actor, 'APPROVER');
  const pending = query.status.includes('PENDING');
  const sort = pending ? QUEUE_SORT.PENDING : QUEUE_SORT.DECIDED;
  const filters: CursorFilters = { status: query.status, from: query.from, to: query.to };
  const range = businessDayRangeToUtc(query.from, query.to);
  const after = query.cursor === undefined ? undefined : readCursor(query.cursor, sort, filters);
  const take = query.limit + 1; // one extra row says whether there is a next page
  const rows = await stepsRepo.listQueue(
    ctx.actor,
    pending
      ? { kind: 'PENDING', range, after, take }
      : {
          kind: 'DECIDED',
          statuses: query.status.filter((s) => s !== 'PENDING'),
          range,
          after,
          take,
        },
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const lastAt = last && (pending ? last.activatedAt : last.decidedAt);
  const nextCursor =
    rows.length > query.limit && last && lastAt
      ? encodeCursor(sort, { value: lastAt.toISOString(), id: last.stepId }, filters)
      : null;
  return { items: page.map(toApprovalTask), nextCursor, limit: query.limit };
}

function readCursor(raw: string, sort: string, filters: CursorFilters): { at: Date; id: string } {
  try {
    const pos = decodeCursor(raw, sort, filters);
    if (pos.value === null) throw new CursorError('the queue sort columns are never null');
    return { at: new Date(pos.value), id: pos.id };
  } catch (err) {
    if (err instanceof CursorError) throw new AppError('INVALID_CURSOR');
    throw err;
  }
}
