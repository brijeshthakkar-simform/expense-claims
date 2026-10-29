import 'server-only';
import { ClaimEventInputSchema, type ClaimEventInput } from '@/server/audit/events';
import type { Tx } from '@/server/db/tx';
import * as eventsRepo from '@/server/repositories/events.repo';
import type { ServiceCtx } from '@/server/services/context';
import type { ClaimEventType, ClaimStatus, EventActorRole } from '@/shared/enums';

// D-22: the single audit writer. Called exactly once per state-changing request, inside the same
// transaction, after the state writes: if the transaction rolls back, so does the event, and the
// deferred assert_transition_audited trigger fails the COMMIT (UC015) if it is missing.

/** from/to and the actor's role follow from the type, so a service can't record a bad transition. */
const TRANSITION = {
  CLAIM_SUBMITTED: { from: 'DRAFT', to: 'SUBMITTED', actorRole: 'CLAIMANT' },
  CLAIM_RESUBMITTED: { from: 'REJECTED', to: 'SUBMITTED', actorRole: 'CLAIMANT' },
  STEP_APPROVED: { from: 'SUBMITTED', to: 'SUBMITTED', actorRole: 'APPROVER' },
  CLAIM_APPROVED: { from: 'SUBMITTED', to: 'APPROVED', actorRole: 'APPROVER' },
  CLAIM_REJECTED: { from: 'SUBMITTED', to: 'REJECTED', actorRole: 'APPROVER' },
  CLAIM_RECALLED: { from: 'SUBMITTED', to: 'DRAFT', actorRole: 'CLAIMANT' },
} as const satisfies Record<
  ClaimEventType,
  { from: ClaimStatus; to: ClaimStatus; actorRole: EventActorRole }
>;

/**
 * Validates and inserts one event. The actor is always ctx.actor (there is no parameter for it),
 * request_id is the request's x-request-id (D-40), and ctx.clock (owner-run seed only) supplies
 * occurred_at. Returns the event id.
 */
export async function recordEvent(
  tx: Tx,
  ctx: ServiceCtx,
  input: ClaimEventInput,
): Promise<{ id: string }> {
  const e = ClaimEventInputSchema.parse(input);
  const t = TRANSITION[e.type];
  return eventsRepo.insert(tx, {
    claimId: e.claimId,
    submissionId: e.submissionId,
    stepId: 'stepId' in e ? e.stepId : null,
    revision: e.revision,
    type: e.type,
    actorId: ctx.actor.id,
    actorRole: t.actorRole,
    fromStatus: t.from,
    toStatus: t.to,
    totalMinor: e.totalMinor,
    reason: 'reason' in e ? (e.reason ?? null) : null,
    payload: e.payload,
    requestId: ctx.requestId,
    occurredAt: ctx.clock?.now(),
  });
}
