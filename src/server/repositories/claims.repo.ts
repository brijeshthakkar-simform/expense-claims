import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';
import { AppError } from '@/server/errors/app-error';
import { RECEIPT_DTO_SELECT, RECEIPT_ORDER } from '@/server/repositories/receipts.repo';
import { CLAIM_STATUSES, type ClaimStatus } from '@/shared/enums';

// Claim rows (C-26). Every mutation starts with an actor-scoped row lock taken inside withTx, so
// out-of-scope actors (finance, approvers, everyone else) never lock someone else's claim.
// `total_minor` is never written from here: the line_items triggers own it (03 §4).

/** The claim facts a service re-reads under the lock. */
export interface LockedClaim {
  id: string;
  claimantId: string;
  status: ClaimStatus;
  title: string;
  currency: string;
  totalMinor: number;
  currentRevision: number;
  currentSubmissionId: string | null;
}

/**
 * The first statement of every owner mutation: `FOR NO KEY UPDATE` (compatible with the FK
 * checks' KEY SHARE, so line writers queue instead of deadlocking) on MY claim. `null` when the
 * claim doesn't exist or isn't mine; the service turns that into 404 CLAIM_NOT_FOUND.
 */
export async function lockOwnedClaim(
  tx: Tx,
  actor: Actor,
  claimId: string,
): Promise<LockedClaim | null> {
  const rows = await tx.$queryRaw<LockedClaim[]>`
    SELECT id, claimant_id AS "claimantId", status::text AS status, title, currency,
           total_minor AS "totalMinor", current_revision AS "currentRevision",
           current_submission_id AS "currentSubmissionId"
      FROM public.claims
     WHERE id = ${claimId}::uuid AND claimant_id = ${actor.id}::uuid
       FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

/**
 * The first statement of every decision (approve/reject): the same lock, scoped instead by "a
 * PENDING step of mine is on this claim". `OF c` locks only the claim row (the steps are read, not
 * locked, by the EXISTS). `null` = not in my queue right now (no such claim, never routed to me,
 * my step WAITING, or already decided); the service diagnoses ALREADY_DECIDED / NOT_IN_YOUR_QUEUE.
 * A PENDING step only ever exists on the current submission (reject and recall cancel every open
 * step before a new one can exist), so no revision filter is needed here. The literal 'PENDING'
 * keeps the EXISTS on approval_steps_visibility_idx (claim_id, approver_id).
 */
export async function lockClaimRoutedToMe(
  tx: Tx,
  actor: Actor,
  claimId: string,
): Promise<LockedClaim | null> {
  const rows = await tx.$queryRaw<LockedClaim[]>`
    SELECT c.id, c.claimant_id AS "claimantId", c.status::text AS status, c.title, c.currency,
           c.total_minor AS "totalMinor", c.current_revision AS "currentRevision",
           c.current_submission_id AS "currentSubmissionId"
      FROM public.claims c
     WHERE c.id = ${claimId}::uuid
       AND EXISTS (SELECT 1 FROM public.approval_steps s
                    WHERE s.claim_id = c.id AND s.approver_id = ${actor.id}::uuid
                      AND s.status = 'PENDING')
       FOR NO KEY UPDATE OF c`;
  return rows[0] ?? null;
}

/**
 * Conditional writes under the lock expect an exact row count. Anything else means the claim
 * changed underneath us (it can't while we hold the lock), so refuse rather than half-apply: the
 * throw rolls the whole transaction back (02 §8.1 step 5).
 */
export function expectCount(count: number, expected: number): void {
  if (count !== expected)
    throw new AppError('CONFLICT', 'The claim changed concurrently. Please retry.', {
      retryable: true,
    });
}
export const expectOne = (count: number): void => expectCount(count, 1);

/** A new, empty DRAFT owned by the actor (claims are born empty: claims_guard, UC003/UC005). */
export async function insertDraft(
  tx: Tx,
  actor: Actor,
  data: { title: string; createdAt?: Date },
): Promise<{ id: string }> {
  // claim_number, status, total and revision come from column defaults; created_at is re-stamped
  // with now() by claims_guard for expense_app (only the owner-run seed may backdate it).
  return tx.claim.create({
    data: { claimantId: actor.id, title: data.title, createdAt: data.createdAt },
    select: { id: true },
  });
}

/** `at`: the SeedClock instant (owner-run seed only) for updated_at; otherwise Prisma stamps it. */
export async function updateTitle(
  tx: Tx,
  actor: Actor,
  claimId: string,
  title: string,
  at?: Date,
): Promise<number> {
  const r = await tx.claim.updateMany({
    where: { id: claimId, claimantId: actor.id },
    data: { title, updatedAt: at },
  });
  return r.count;
}

/**
 * DRAFT/REJECTED → SUBMITTED, pointing at the brand-new submission (revision N+1). Conditional on
 * the status and revision read under the lock (count 1). claims_guard then proves the chain shape
 * (UC012) and the snapshot (UC016) and stamps submitted_at; the deferred assert_transition_audited
 * needs the CLAIM_SUBMITTED / CLAIM_RESUBMITTED event in this transaction (UC015).
 */
export async function markSubmitted(
  tx: Tx,
  actor: Actor,
  claimId: string,
  s: { from: ClaimStatus; revision: number; submissionId: string; at?: Date },
): Promise<number> {
  const r = await tx.claim.updateMany({
    where: { id: claimId, claimantId: actor.id, status: s.from, currentRevision: s.revision - 1 },
    data: {
      status: 'SUBMITTED',
      currentRevision: s.revision,
      currentSubmissionId: s.submissionId,
      submittedAt: s.at, // SeedClock only; the DB stamps it for expense_app (D-23)
    },
  });
  return r.count;
}

/**
 * SUBMITTED → APPROVED after the final level was approved in this transaction. Conditional on the
 * status and the submission read under the routed-to-me lock (count 1). claims_guard proves every
 * step of the current submission is APPROVED (UC011) and stamps approved_at; `at` (SeedClock,
 * owner-run seed only) backdates it. The deferred audit check needs the CLAIM_APPROVED event.
 */
export async function markApproved(
  tx: Tx,
  claimId: string,
  s: { submissionId: string; at?: Date },
): Promise<number> {
  const r = await tx.claim.updateMany({
    where: { id: claimId, status: 'SUBMITTED', currentSubmissionId: s.submissionId },
    data: { status: 'APPROVED', approvedAt: s.at, updatedAt: s.at },
  });
  return r.count;
}

/**
 * SUBMITTED → REJECTED after my step was rejected and the later WAITING steps cancelled in this
 * transaction. claims_guard requires a REJECTED step and no open steps (UC011) and stamps
 * rejected_at (`at` = SeedClock only).
 */
export async function markRejected(
  tx: Tx,
  claimId: string,
  s: { submissionId: string; at?: Date },
): Promise<number> {
  const r = await tx.claim.updateMany({
    where: { id: claimId, status: 'SUBMITTED', currentSubmissionId: s.submissionId },
    data: { status: 'REJECTED', rejectedAt: s.at, updatedAt: s.at },
  });
  return r.count;
}

/**
 * SUBMITTED → DRAFT (recall) after every open step of the current submission was cancelled in
 * this transaction. Owner-scoped and conditional on the status and submission read under the lock
 * (count 1). claims_guard refuses it while any step is still WAITING/PENDING (UC012); the revision
 * and submission pointer stay. `at` (SeedClock only) backdates updated_at.
 */
export async function markRecalled(
  tx: Tx,
  actor: Actor,
  claimId: string,
  s: { submissionId: string; at?: Date },
): Promise<number> {
  const r = await tx.claim.updateMany({
    where: {
      id: claimId,
      claimantId: actor.id,
      status: 'SUBMITTED',
      currentSubmissionId: s.submissionId,
    },
    data: { status: 'DRAFT', updatedAt: s.at },
  });
  return r.count;
}

/** Deletes my claim; its lines cascade. claims_guard refuses APPROVED (UC001) and revision > 0 (UC017). */
export async function deleteOwnedClaim(tx: Tx, actor: Actor, claimId: string): Promise<number> {
  const r = await tx.claim.deleteMany({ where: { id: claimId, claimantId: actor.id } });
  return r.count;
}

// ----------------------------------------------------------------------------------- reads

/** One approval step as ApprovalStepDto needs it. */
const STEP_DTO_SELECT = {
  level: true,
  tierCode: true,
  tierLabel: true,
  status: true,
  activatedAt: true,
  decidedAt: true,
  comment: true,
  rejectionReason: true,
  approver: { select: { id: true, name: true } },
} satisfies Prisma.ApprovalStepSelect;
export type StepDtoRow = Prisma.ApprovalStepGetPayload<{ select: typeof STEP_DTO_SELECT }>;

/**
 * What ClaimDetail is built from: the claim, its lines, the current submission's chain and the
 * last rejection.
 */
export const CLAIM_DETAIL_SELECT = {
  id: true,
  claimNumber: true,
  title: true,
  status: true,
  currency: true,
  totalMinor: true,
  currentRevision: true,
  claimantId: true,
  createdAt: true,
  submittedAt: true,
  approvedAt: true,
  rejectedAt: true,
  claimant: { select: { id: true, name: true } },
  lineItems: {
    // Snapshot order (C-21), served by line_items_claim_idx (claim_id, expense_date, id).
    orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      expenseDate: true,
      amountMinor: true,
      description: true,
      merchant: true,
      category: { select: { id: true, code: true, name: true, isActive: true } },
      receipts: { orderBy: [...RECEIPT_ORDER], select: RECEIPT_DTO_SELECT },
    },
  },
  // The chain of the newest submission (null at revision 0).
  currentSubmission: {
    select: { revision: true, steps: { orderBy: { level: 'asc' }, select: STEP_DTO_SELECT } },
  },
  // lastRejection: the newest REJECTED step of any revision (a submission has at most one).
  approvalSteps: {
    where: { status: 'REJECTED' },
    orderBy: [{ submission: { revision: 'desc' } }],
    take: 1,
    select: {
      level: true,
      decidedAt: true,
      rejectionReason: true,
      approver: { select: { id: true, name: true } },
      submission: { select: { revision: true } },
    },
  },
} satisfies Prisma.ClaimSelect;
export type ClaimDetailRow = Prisma.ClaimGetPayload<{ select: typeof CLAIM_DETAIL_SELECT }>;

/**
 * GET …/history (02 §10.5): every submission with its snapshot and chain, and every event in
 * timeline order (claim_events_timeline_idx). Loaded only through findClaimForActor, so the
 * children are read only when the claim itself passed the visibility predicate.
 */
export const CLAIM_HISTORY_SELECT = {
  id: true,
  submissions: {
    orderBy: { revision: 'asc' },
    select: {
      revision: true,
      submittedAt: true,
      totalMinor: true,
      lineItemCount: true,
      snapshot: true,
      steps: { orderBy: { level: 'asc' }, select: STEP_DTO_SELECT },
    },
  },
  events: {
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      type: true,
      occurredAt: true,
      actor: { select: { id: true, name: true } },
      actorRole: true,
      revision: true,
      fromStatus: true,
      toStatus: true,
      reason: true,
      payload: true,
      requestId: true,
    },
  },
} satisfies Prisma.ClaimSelect;
export type ClaimHistoryRow = Prisma.ClaimGetPayload<{ select: typeof CLAIM_HISTORY_SELECT }>;

/** One row of GET /api/v1/claims (ClaimSummary is built from it). */
export interface ClaimSummaryRow {
  id: string;
  claimNumber: string;
  title: string;
  status: ClaimStatus;
  currency: string;
  totalMinor: number;
  currentRevision: number;
  lineItemCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
}

export interface ListMineArgs {
  statuses: readonly ClaimStatus[];
  /** Half-open UTC range on created_at (from businessDayRangeToUtc). */
  createdAt: { gte?: Date; lt?: Date };
  /** Keyset position: rows strictly after (createdAt, id) in DESC order. */
  after?: { createdAt: Date; id: string };
  /** limit + 1, so the caller can tell whether another page exists. */
  take: number;
}

// Instants travel as ISO strings with an explicit cast: no dependence on the session TimeZone.
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz`;

/**
 * The page SQL of GET /api/v1/claims (04 §5.4, §8.2; exported for EXPLAIN captures). The scope
 * `claimant_id = me` is the first conjunct and never comes from input; with `created_at DESC, id
 * DESC` it is a range scan of claims_claimant_list_idx, Limit → Index Scan with no Sort at any
 * depth (keyset, not OFFSET), the cursor's row comparison inside the same Index Cond. (When fewer
 * rows than the LIMIT are left in range, the planner may instead read that short tail with a
 * bitmap scan of the same index and sort it.) One statement per page (06 §7 rule 5), like the
 * finance list: the line count is a correlated count on line_items_claim_idx, evaluated only for
 * the rows the LIMIT lets through. (Prisma's `_count` joined a GROUP BY over the whole line_items
 * table on every page.)
 */
export function listMineSql(actor: Actor, a: ListMineArgs): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`c.claimant_id = ${actor.id}::uuid`];
  const statuses = [...new Set(a.statuses)];
  if (statuses.length === 0) {
    where.push(Prisma.sql`FALSE`); // not from the route: ClaimListQuery requires ≥ 1 status
  } else if (statuses.length < CLAIM_STATUSES.length) {
    const list = statuses.map((s) => Prisma.sql`${s}::public.claim_status`);
    where.push(Prisma.sql`c.status IN (${Prisma.join(list)})`);
  }
  if (a.createdAt.gte) where.push(Prisma.sql`c.created_at >= ${ts(a.createdAt.gte)}`);
  if (a.createdAt.lt) where.push(Prisma.sql`c.created_at < ${ts(a.createdAt.lt)}`);
  if (a.after)
    where.push(Prisma.sql`(c.created_at, c.id) < (${ts(a.after.createdAt)}, ${a.after.id}::uuid)`);
  return Prisma.sql`
    SELECT c.id, c.claim_number AS "claimNumber", c.title, c.status::text AS status, c.currency,
           c.total_minor AS "totalMinor", c.current_revision AS "currentRevision",
           (SELECT count(*)::int FROM public.line_items li WHERE li.claim_id = c.id)
             AS "lineItemCount",
           c.created_at AS "createdAt", c.submitted_at AS "submittedAt",
           c.approved_at AS "approvedAt"
      FROM public.claims c
     WHERE ${Prisma.join(where, ' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${a.take}`;
}

/** GET /api/v1/claims: one keyset page of MY claims, newest first (see listMineSql). */
export function listMine(actor: Actor, a: ListMineArgs): Promise<ClaimSummaryRow[]> {
  return getDb().$queryRaw<ClaimSummaryRow[]>(listMineSql(actor, a));
}
