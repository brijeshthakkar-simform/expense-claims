import 'server-only';
import { recordEvent } from '@/server/audit/record-event';
import { assertOk, decide } from '@/server/authz/claim-policy';
import { withTx } from '@/server/db/tx';
import { AppError } from '@/server/errors/app-error';
import { logEvent } from '@/server/logging/logger';
import * as claimsRepo from '@/server/repositories/claims.repo';
import { expectCount, expectOne, type LockedClaim } from '@/server/repositories/claims.repo';
import * as lineItemsRepo from '@/server/repositories/line-items.repo';
import type { SnapshotLineRow } from '@/server/repositories/line-items.repo';
import * as stepsRepo from '@/server/repositories/steps.repo';
import type { StepRow } from '@/server/repositories/steps.repo';
import * as submissionsRepo from '@/server/repositories/submissions.repo';
import * as tiersRepo from '@/server/repositories/tiers.repo';
import * as usersRepo from '@/server/repositories/users.repo';
import type { ClaimantIdentity } from '@/server/repositories/users.repo';
import { buildChain } from '@/server/routing/build-chain';
import { loadOrgLookup } from '@/server/routing/org-loader';
import { assertPolicyWellFormed } from '@/server/routing/policy';
import { getClaim } from '@/server/services/claims.service';
import type { ServiceCtx } from '@/server/services/context';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { SnapshotV1 } from '@/shared/dto/snapshot';
import type { ApiIssue } from '@/shared/errors';
import type { RecallInput, SubmitInput } from '@/shared/schemas/claims';

// Submit / resubmit (02 §9.1, C-25) and recall (02 §9.4). One code path for first submit and
// resubmit, so there is one chain builder to test. Everything below runs in one withTx; the DB
// re-proves each step (snapshot UC016, chain shape UC012, audit UC015) before COMMIT.

/**
 * C-21 snapshot v1 from the rows read under the lock, receipts included (storageKey + sha256):
 * claim_submissions_verify v2 proves they equal the live receipts (UC016 otherwise).
 */
export function toSnapshotV1(
  claimant: ClaimantIdentity,
  claim: Pick<LockedClaim, 'title' | 'currency' | 'totalMinor'>,
  lines: readonly SnapshotLineRow[],
): SnapshotV1 {
  return {
    v: 1,
    claimant,
    title: claim.title,
    currency: claim.currency,
    totalMinor: claim.totalMinor,
    lines: lines.map((l) => ({
      lineItemId: l.id,
      expenseDate: l.expenseDate,
      categoryId: l.category.id,
      categoryCode: l.category.code,
      categoryName: l.category.name,
      glCode: l.category.glCode,
      amountMinor: l.amountMinor,
      description: l.description,
      merchant: l.merchant,
      receipts: l.receipts.map((r) => ({
        receiptId: r.id,
        fileName: r.fileName,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        sha256: r.sha256,
        storageKey: r.storageKey,
      })),
    })),
  };
}

/**
 * POST /api/v1/claims/:claimId/submit, in the C-25 order: lock my claim → status (409) → lines
 * (422 NO_LINE_ITEMS / CATEGORY_INACTIVE) → active tiers + org → buildChain (422
 * ROUTING_UNRESOLVABLE) → INSERT submission (revision + 1, snapshot) → INSERT steps (L1 PENDING,
 * rest WAITING) → UPDATE claim → recordEvent(CLAIM_SUBMITTED | CLAIM_RESUBMITTED) → COMMIT → log.
 */
export async function submit(
  ctx: ServiceCtx,
  claimId: string,
  // C-26 signature. The body is strictly `{}` today (SubmitInput), so nothing reads it yet.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _input: SubmitInput = {},
): Promise<ClaimDetail> {
  const { actor } = ctx;
  const at = ctx.clock?.now(); // owner-run seed only (02 §9)
  const done = await withTx(async (tx) => {
    // 1–2. Owner-scoped lock, then the status under the lock.
    const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
    if (!claim) throw new AppError('CLAIM_NOT_FOUND');
    assertOk(
      decide(actor, {
        status: claim.status,
        claimantId: claim.claimantId,
        currentRevision: claim.currentRevision,
        myStepOnCurrentRevision: null,
      }).SUBMIT,
    ); // APPROVED → 409 CLAIM_LOCKED; SUBMITTED → 409 INVALID_STATUS_TRANSITION

    // 3. Lines, with a fresh statement after the lock.
    const lines = await lineItemsRepo.listForSnapshot(tx, actor, claim.id);
    if (lines.length === 0) throw new AppError('NO_LINE_ITEMS');
    const retired = lines.flatMap((l, i): ApiIssue[] =>
      l.category.isActive
        ? []
        : [
            {
              path: ['lineItems', i, 'categoryId'],
              message: 'This category is no longer available',
              code: 'CATEGORY_INACTIVE',
            },
          ],
    );
    if (retired.length) throw new AppError('CATEGORY_INACTIVE', undefined, { issues: retired });

    // 4–5. Route: the active tiers + the org chart as of now → one distinct approver per tier.
    const tiers = await tiersRepo.listActive(tx);
    assertPolicyWellFormed(tiers);
    const org = await loadOrgLookup(tx, claim.claimantId, tiers);
    const claimant = org.get(claim.claimantId);
    if (!claimant) throw new AppError('CLAIM_NOT_FOUND'); // unreachable: the lock found my claim
    const chain = buildChain({ tiers, claimant, org, totalMinor: claim.totalMinor });

    // 6. The submission: revision N+1 and its snapshot (verified and frozen by the DB).
    const revision = claim.currentRevision + 1;
    const previous = claim.currentSubmissionId
      ? await submissionsRepo.summary(tx, claim.currentSubmissionId)
      : null;
    const submission = await submissionsRepo.insert(tx, {
      claimId: claim.id,
      revision,
      submittedById: actor.id,
      totalMinor: claim.totalMinor,
      currency: claim.currency,
      lineItemCount: lines.length,
      snapshot: toSnapshotV1(await usersRepo.claimantIdentity(tx, claim.claimantId), claim, lines),
      submittedAt: at,
    });

    // 7. The chain: level 1 PENDING, the rest WAITING.
    expectCount(await stepsRepo.insertChain(tx, claim.id, submission.id, chain, at), chain.length);

    // 8. The claim: → SUBMITTED, pointing at the new submission.
    expectOne(
      await claimsRepo.markSubmitted(tx, actor, claim.id, {
        from: claim.status,
        revision,
        submissionId: submission.id,
        at,
      }),
    );

    // 9. One typed event, same transaction (UC015 at COMMIT without it).
    const type = claim.status === 'REJECTED' ? 'CLAIM_RESUBMITTED' : 'CLAIM_SUBMITTED';
    const payload = {
      lineItemCount: lines.length,
      chain: chain.map(({ level, tierCode, approverId, resolvedVia }) => ({
        level,
        tierCode,
        approverId,
        resolvedVia,
      })),
      ...(previous && {
        previousRevision: {
          revision: previous.revision,
          totalMinor: previous.totalMinor,
          outcome: claim.status === 'REJECTED' ? ('REJECTED' as const) : ('RECALLED' as const),
        },
      }),
    };
    const base = {
      claimId: claim.id,
      submissionId: submission.id,
      revision,
      totalMinor: claim.totalMinor,
    };
    await recordEvent(
      tx,
      ctx,
      type === 'CLAIM_RESUBMITTED'
        ? { ...base, type, payload: { ...payload, previousRevision: payload.previousRevision! } }
        : { ...base, type, payload },
    );
    return { type, revision, levelCount: chain.length };
  });

  // 10. After commit: the domain log line (same requestId as the event).
  logEvent(done.type === 'CLAIM_RESUBMITTED' ? 'claim.resubmitted' : 'claim.submitted', {
    claimId,
    revision: done.revision,
    levelCount: done.levelCount,
  });
  return getClaim(ctx, claimId);
}

/**
 * POST /api/v1/claims/:claimId/recall, in the C-25 order: lock my claim → status (APPROVED → 409
 * CLAIM_LOCKED; not SUBMITTED → 409 INVALID_STATUS_TRANSITION) → the current submission's steps,
 * fresh after the lock → its PENDING/WAITING steps → CANCELLED (APPROVED ones stay, in history
 * against that revision) → claim SUBMITTED → DRAFT (revision and submission pointer unchanged) →
 * recordEvent(CLAIM_RECALLED) → COMMIT → log → fresh detail. Legal until the final approval,
 * including after intermediate approvals (02 §6.3); the next submit routes from scratch.
 */
export async function recall(
  ctx: ServiceCtx,
  claimId: string,
  input: RecallInput = {},
): Promise<ClaimDetail> {
  const { actor } = ctx;
  const at = ctx.clock?.now(); // owner-run seed only (02 §9)
  const note = input.note ? input.note : undefined; // '' (after trim) = no note
  const done = await withTx(async (tx) => {
    // 1–2. Owner-scoped lock (a non-owner, finance included, gets the random-id 404), then status.
    const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
    if (!claim) throw new AppError('CLAIM_NOT_FOUND');
    assertOk(
      decide(actor, {
        status: claim.status,
        claimantId: claim.claimantId,
        currentRevision: claim.currentRevision,
        myStepOnCurrentRevision: null,
      }).RECALL,
    ); // APPROVED → 409 CLAIM_LOCKED; DRAFT/REJECTED → 409 INVALID_STATUS_TRANSITION
    const submissionId = claim.currentSubmissionId;
    if (!submissionId) throw new Error(`SUBMITTED claim ${claim.id} has no current submission`);

    // 3. The chain as it is now: a fresh statement after the lock, so an approval that committed
    //    while we waited (the just-activated next level) is seen and cancelled too.
    const steps = await stepsRepo.listForSubmission(tx, submissionId);
    const open = steps.filter(
      (s): s is StepRow & { status: 'PENDING' | 'WAITING' } =>
        s.status === 'PENDING' || s.status === 'WAITING',
    );
    const cancelled = await stepsRepo.cancelOpen(tx, submissionId, at);
    expectCount(cancelled.length, open.length);

    // 4. The claim: SUBMITTED → DRAFT (claims_guard: UC012 if any step were still open).
    expectOne(await claimsRepo.markRecalled(tx, actor, claim.id, { submissionId, at }));

    // 5. One typed event, same transaction (UC015 at COMMIT without it).
    const approvedLevelsVoided = steps.filter((s) => s.status === 'APPROVED').length;
    await recordEvent(tx, ctx, {
      type: 'CLAIM_RECALLED',
      claimId: claim.id,
      submissionId,
      revision: claim.currentRevision,
      totalMinor: claim.totalMinor, // = the submission total: lines are frozen while SUBMITTED
      reason: note,
      payload: {
        cancelledSteps: open.map((s) => ({
          stepId: s.id,
          level: s.level,
          approverId: s.approverId,
          wasStatus: s.status,
        })),
        approvedLevelsVoided,
      },
    });
    return {
      revision: claim.currentRevision,
      cancelledSteps: open.length,
      approvedLevelsVoided,
    };
  });

  // 6. After commit: the domain log line (same requestId as the event).
  logEvent('claim.recalled', { claimId, ...done });
  return getClaim(ctx, claimId);
}
