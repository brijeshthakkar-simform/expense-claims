import 'server-only';
import { canDecide, type Actor } from '@/server/auth/actor';
import { AppError, type ErrorDetails } from '@/server/errors/app-error';
import type { ErrorCode } from '@/server/errors/codes';
import {
  CLAIM_ACTIONS,
  type ApprovalStepStatus,
  type ClaimAction,
  type ClaimStatus,
  type SubmissionOutcome,
} from '@/shared/enums';

// 04 §4.4 / 02 §2.4: the claim state machine as one pure function over facts re-read under the
// lock. Services use it for the 409 codes; ClaimDetail.allowedActions comes from the same function,
// so the UI never re-implements the rules and hiding a button never protects anything.

export type { ClaimAction };

export interface ClaimFacts {
  status: ClaimStatus;
  claimantId: string;
  currentRevision: number;
  /** My step on claims.current_submission_id, if any (null for owner actions). */
  myStepOnCurrentRevision: ApprovalStepStatus | null;
}

export type Decision = { ok: true } | { ok: false; code: ErrorCode };

const allow: Decision = { ok: true };
const deny = (code: ErrorCode): Decision => ({ ok: false, code });

export function decide(actor: Actor, f: ClaimFacts): Record<ClaimAction, Decision> {
  // A non-owner never learns the claim's state from an owner action: same 404 as a random id.
  const ownerOnly = (d: Decision) => (f.claimantId === actor.id ? d : deny('CLAIM_NOT_FOUND'));
  const locked = f.status === 'APPROVED';
  const editable = f.status === 'DRAFT' || f.status === 'REJECTED';
  const decision = !canDecide(actor)
    ? deny('FORBIDDEN')
    : f.myStepOnCurrentRevision === 'PENDING'
      ? allow
      : f.myStepOnCurrentRevision === 'APPROVED' || f.myStepOnCurrentRevision === 'REJECTED'
        ? deny('ALREADY_DECIDED')
        : deny('NOT_IN_YOUR_QUEUE');
  return {
    EDIT: ownerOnly(locked ? deny('CLAIM_LOCKED') : editable ? allow : deny('CLAIM_NOT_EDITABLE')),
    SUBMIT: ownerOnly(
      locked ? deny('CLAIM_LOCKED') : editable ? allow : deny('INVALID_STATUS_TRANSITION'),
    ),
    RECALL: ownerOnly(
      locked
        ? deny('CLAIM_LOCKED')
        : f.status === 'SUBMITTED'
          ? allow
          : deny('INVALID_STATUS_TRANSITION'),
    ),
    DELETE: ownerOnly(
      locked
        ? deny('CLAIM_LOCKED')
        : f.status === 'DRAFT' && f.currentRevision === 0
          ? allow
          : deny('CLAIM_HAS_HISTORY'),
    ),
    APPROVE: decision,
    REJECT: decision,
  };
}

/** The actions `decide` allows, in the canonical CLAIM_ACTIONS order. */
export function allowedActions(actor: Actor, f: ClaimFacts): ClaimAction[] {
  const d = decide(actor, f);
  return CLAIM_ACTIONS.filter((a) => d[a].ok);
}

// The details each refusal carries (04 §9.2), the same ones the DB-backstop mapping adds.
const REFUSAL_DETAILS: Partial<Record<ErrorCode, ErrorDetails>> = {
  CLAIM_LOCKED: { status: 'APPROVED' },
  CLAIM_NOT_EDITABLE: { hint: 'RECALL_TO_EDIT' },
};

/** Throws the decision's specific AppError (409 CLAIM_LOCKED, CLAIM_NOT_EDITABLE, …). */
export function assertOk(d: Decision): void {
  if (!d.ok) throw new AppError(d.code, undefined, REFUSAL_DETAILS[d.code]);
}

/**
 * A submission's outcome from its steps (D-18): any REJECTED → REJECTED; all APPROVED → APPROVED;
 * any CANCELLED with none REJECTED → RECALLED; otherwise IN_APPROVAL.
 */
export function submissionOutcome(
  steps: readonly { status: ApprovalStepStatus }[],
): SubmissionOutcome {
  if (steps.some((s) => s.status === 'REJECTED')) return 'REJECTED';
  if (steps.length > 0 && steps.every((s) => s.status === 'APPROVED')) return 'APPROVED';
  if (steps.some((s) => s.status === 'CANCELLED')) return 'RECALLED';
  return 'IN_APPROVAL';
}
