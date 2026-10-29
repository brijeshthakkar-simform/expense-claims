import { z } from 'zod';
import { ApprovalStepDto, UserRef } from '@/shared/dto/claims';
import { SnapshotV1 } from '@/shared/dto/snapshot';
import { ClaimEventType, ClaimStatus, EventActorRole, SubmissionOutcome } from '@/shared/enums';

// C-10 / 04 §7.3 / 02 §10.5: GET /api/v1/claims/:claimId/history. Everything that ever happened to
// a claim, read through the same visibility predicate as the claim itself. Bounded per claim, so
// there is no pagination. Instants are UTC ISO with Z; money is integer paise.

const Instant = z.iso.datetime();

/** One revision: its frozen snapshot, its derived outcome and its chain (steps in level order). */
export const ClaimHistorySubmission = z.object({
  revision: z.number().int(),
  submittedAt: Instant,
  /** The submission total (= snapshot.totalMinor). */
  totalMinor: z.number().int(),
  lineItemCount: z.number().int(),
  /** Derived from the steps by submissionOutcome() (D-18); never stored. */
  outcome: SubmissionOutcome,
  snapshot: SnapshotV1,
  steps: z.array(ApprovalStepDto),
});
export type ClaimHistorySubmission = z.infer<typeof ClaimHistorySubmission>;

/** One claim_events row (C-20), in (occurredAt, id) order. */
export const ClaimHistoryEvent = z.object({
  id: z.uuid(),
  type: ClaimEventType,
  occurredAt: Instant,
  actor: UserRef,
  actorRole: EventActorRole,
  revision: z.number().int(),
  fromStatus: ClaimStatus,
  toStatus: ClaimStatus,
  /** Rejection reason, approve comment or recall note (null when none). */
  reason: z.string().nullable(),
  /** The type's C-20 payload (chain, previousRevision, cancelledSteps, …); ids, not names. */
  payload: z.record(z.string(), z.unknown()),
  /** The request's x-request-id: joins this row to the logs (D-40). */
  requestId: z.string(),
});
export type ClaimHistoryEvent = z.infer<typeof ClaimHistoryEvent>;

export const ClaimHistory = z.object({
  /** Revision 1..N, ascending. Empty for a never-submitted draft. */
  submissions: z.array(ClaimHistorySubmission),
  /** Every event, oldest first. */
  events: z.array(ClaimHistoryEvent),
});
export type ClaimHistory = z.infer<typeof ClaimHistory>;
