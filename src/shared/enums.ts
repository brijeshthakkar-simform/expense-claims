import { z } from 'zod';

// C-02: the DB enums the client sees, as Zod enums. The server proves at compile time that these
// equal the Prisma enums (src/server/repositories/users.repo.ts), so drift fails typecheck.

export const USER_ROLES = ['EMPLOYEE', 'FINANCE', 'ADMIN'] as const;
export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

export const CLAIM_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export const ClaimStatus = z.enum(CLAIM_STATUSES);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const APPROVAL_STEP_STATUSES = [
  'WAITING',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export const ApprovalStepStatus = z.enum(APPROVAL_STEP_STATUSES);
export type ApprovalStepStatus = z.infer<typeof ApprovalStepStatus>;

export const APPROVER_RESOLVERS = ['REPORTING_LINE', 'DESIGNATED_USER'] as const;
export const ApproverResolver = z.enum(APPROVER_RESOLVERS);
export type ApproverResolver = z.infer<typeof ApproverResolver>;

/** The six audit event types (C-20); one per state-changing request. */
export const CLAIM_EVENT_TYPES = [
  'CLAIM_SUBMITTED',
  'CLAIM_RESUBMITTED',
  'STEP_APPROVED',
  'CLAIM_APPROVED',
  'CLAIM_REJECTED',
  'CLAIM_RECALLED',
] as const;
export const ClaimEventType = z.enum(CLAIM_EVENT_TYPES);
export type ClaimEventType = z.infer<typeof ClaimEventType>;

export const EVENT_ACTOR_ROLES = ['CLAIMANT', 'APPROVER'] as const;
export const EventActorRole = z.enum(EVENT_ACTOR_ROLES);
export type EventActorRole = z.infer<typeof EventActorRole>;

/** How a step's approver was found (approval_steps.resolved_via, CHECK steps_resolved_via). */
export const RESOLVED_VIA = ['PRIMARY', 'ESCALATED', 'FALLBACK'] as const;
export const ResolvedVia = z.enum(RESOLVED_VIA);
export type ResolvedVia = z.infer<typeof ResolvedVia>;

// TS-only (never stored, C-02).

/** What the caller may do next (`ClaimDetail.allowedActions`, from the server's pure decide()). */
export const CLAIM_ACTIONS = ['EDIT', 'SUBMIT', 'RECALL', 'DELETE', 'APPROVE', 'REJECT'] as const;
export const ClaimAction = z.enum(CLAIM_ACTIONS);
export type ClaimAction = z.infer<typeof ClaimAction>;

/** A submission's outcome, derived from its steps (D-18): the "submission status". */
export const SUBMISSION_OUTCOMES = ['IN_APPROVAL', 'APPROVED', 'REJECTED', 'RECALLED'] as const;
export const SubmissionOutcome = z.enum(SUBMISSION_OUTCOMES);
export type SubmissionOutcome = z.infer<typeof SubmissionOutcome>;
