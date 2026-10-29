import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';
import type { PlannedStep } from '@/server/routing/build-chain';
import type { ApprovalStepStatus, ResolvedVia } from '@/shared/enums';

// approval_steps (02 §2.2). Inserted only by a submit, for the claim's newest submission, while the
// claim is still DRAFT/REJECTED (approval_steps_guard: UC012, eligibility UC008). Never deleted (no
// grant, UC007). Decision timestamps are DB-owned for expense_app.

/**
 * The chain of a new submission: level 1 PENDING, the rest WAITING, with the tier copies and
 * resolved_via. `at` (SeedClock only) becomes level 1's activated_at; otherwise the DB stamps it.
 */
export async function insertChain(
  tx: Tx,
  claimId: string,
  submissionId: string,
  chain: readonly PlannedStep[],
  at?: Date,
): Promise<number> {
  const r = await tx.approvalStep.createMany({
    data: chain.map((s) => ({
      claimId,
      submissionId,
      level: s.level,
      tierCode: s.tierCode,
      tierLabel: s.tierLabel,
      appliesAboveMinor: s.appliesAboveMinor,
      approverId: s.approverId,
      resolvedVia: s.resolvedVia,
      status: s.level === 1 ? 'PENDING' : 'WAITING',
      activatedAt: s.level === 1 ? at : undefined,
    })),
  });
  return r.count;
}

export interface StepRow {
  id: string;
  level: number;
  tierCode: string;
  approverId: string;
  resolvedVia: ResolvedVia;
  status: ApprovalStepStatus;
}

/** A submission's steps in level order (fresh read inside the caller's transaction). */
export async function listForSubmission(tx: Tx, submissionId: string): Promise<StepRow[]> {
  const rows = await tx.approvalStep.findMany({
    where: { submissionId },
    orderBy: { level: 'asc' },
    select: {
      id: true,
      level: true,
      tierCode: true,
      approverId: true,
      resolvedVia: true,
      status: true,
    },
  });
  return rows.map((r) => ({ ...r, resolvedVia: r.resolvedVia as ResolvedVia }));
}

// ------------------------------------------------------------------------------ decisions (P4)
// Every write below is conditional on the status the service just read under the claim lock and
// returns the row count (the service expects exactly 1). Decision writes are also scoped to the
// actor (`approver_id = me`). Timestamps: `at` is the SeedClock (owner-run seed only); otherwise
// approval_steps_guard stamps decided_at / activated_at / cancelled_at with now().

/** My PENDING step, plus what the decision event needs. */
export interface MyPendingStep {
  id: string;
  submissionId: string;
  level: number;
  /** Steps in the submission (the chain length). */
  levelCount: number;
  tierCode: string;
}

/**
 * My PENDING step on the submission, as a fresh statement after the claim lock (02 §8.1 step 4):
 * if the lock had to wait, this sees the winner's committed rows, which the lock's EXISTS can't.
 */
export async function findMyPendingStep(
  tx: Tx,
  actor: Actor,
  submissionId: string,
): Promise<MyPendingStep | null> {
  const s = await tx.approvalStep.findFirst({
    where: { submissionId, approverId: actor.id, status: 'PENDING' },
    select: {
      id: true,
      submissionId: true,
      level: true,
      tierCode: true,
      submission: { select: { _count: { select: { steps: true } } } },
    },
  });
  return (
    s && {
      id: s.id,
      submissionId: s.submissionId,
      level: s.level,
      levelCount: s.submission._count.steps,
      tierCode: s.tierCode,
    }
  );
}

/**
 * The diagnosis for "no PENDING step of mine" (04 §5.3): did I approve or reject the claim's
 * CURRENT submission? Only then is the answer 409 ALREADY_DECIDED; a random id, another
 * approver's claim, a WAITING step or an older revision I signed all give 403 NOT_IN_YOUR_QUEUE,
 * so there is no existence oracle. Served by the (submission_id, approver_id) unique index.
 */
export async function didIDecideCurrentRevision(
  tx: Tx,
  actor: Actor,
  claimId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ decided: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM public.claims c
        JOIN public.approval_steps s ON s.submission_id = c.current_submission_id
       WHERE c.id = ${claimId}::uuid AND s.approver_id = ${actor.id}::uuid
         AND s.status IN ('APPROVED', 'REJECTED')) AS decided`;
  return rows[0]?.decided === true;
}

/** PENDING → APPROVED (+ optional comment). approval_steps_guard re-checks eligibility (UC008). */
export async function approveStep(
  tx: Tx,
  actor: Actor,
  stepId: string,
  d: { comment: string | null; at?: Date },
): Promise<number> {
  const r = await tx.approvalStep.updateMany({
    where: { id: stepId, approverId: actor.id, status: 'PENDING' },
    data: { status: 'APPROVED', comment: d.comment, decidedAt: d.at },
  });
  return r.count;
}

/** PENDING → REJECTED with the reason (CHECK steps_reason_length 10..1000; UC008 re-checked). */
export async function rejectStep(
  tx: Tx,
  actor: Actor,
  stepId: string,
  d: { reason: string; at?: Date },
): Promise<number> {
  const r = await tx.approvalStep.updateMany({
    where: { id: stepId, approverId: actor.id, status: 'PENDING' },
    data: { status: 'REJECTED', rejectionReason: d.reason, decidedAt: d.at },
  });
  return r.count;
}

/** The step at `level` of a submission (the next level after an approval), or null past the end. */
export function findByLevel(
  tx: Tx,
  submissionId: string,
  level: number,
): Promise<{ id: string; approverId: string; status: ApprovalStepStatus } | null> {
  return tx.approvalStep.findUnique({
    where: { submissionId_level: { submissionId, level } },
    select: { id: true, approverId: true, status: true },
  });
}

/** WAITING → PENDING (the guard allows it only once the previous level is APPROVED, UC012). */
export async function activateStep(tx: Tx, stepId: string, at?: Date): Promise<number> {
  const r = await tx.approvalStep.updateMany({
    where: { id: stepId, status: 'WAITING' },
    data: { status: 'PENDING', activatedAt: at },
  });
  return r.count;
}

/** After a rejection: every later WAITING step of the submission → CANCELLED. Returns their ids. */
export async function cancelWaiting(tx: Tx, submissionId: string, at?: Date): Promise<string[]> {
  const rows = await tx.approvalStep.updateManyAndReturn({
    where: { submissionId, status: 'WAITING' },
    data: { status: 'CANCELLED', cancelledAt: at },
    select: { id: true, level: true },
  });
  return rows.sort((a, b) => a.level - b.level).map((r) => r.id);
}

/**
 * Recall (02 §9.4): every open (PENDING or WAITING) step of the submission → CANCELLED. APPROVED
 * steps are left as they are, in history against that revision. Returns the cancelled steps in
 * level order; the service expects exactly the open steps it read under the claim lock.
 */
export async function cancelOpen(
  tx: Tx,
  submissionId: string,
  at?: Date,
): Promise<{ id: string; level: number }[]> {
  const rows = await tx.approvalStep.updateManyAndReturn({
    where: { submissionId, status: { in: ['PENDING', 'WAITING'] } },
    data: { status: 'CANCELLED', cancelledAt: at },
    select: { id: true, level: true },
  });
  return rows.sort((a, b) => a.level - b.level);
}

/** The submission's approvers in level order (the CLAIM_APPROVED payload). */
export async function approverIdsInOrder(tx: Tx, submissionId: string): Promise<string[]> {
  const rows = await tx.approvalStep.findMany({
    where: { submissionId },
    orderBy: { level: 'asc' },
    select: { approverId: true },
  });
  return rows.map((r) => r.approverId);
}

// ----------------------------------------------------------------------- the approver queue (P4)

/** One row of GET /api/v1/approvals: my step, its submission and its claim. */
export interface QueueRow {
  stepId: string;
  level: number;
  levelCount: number;
  tierLabel: string;
  status: ApprovalStepStatus;
  activatedAt: Date | null;
  decidedAt: Date | null;
  claimId: string;
  claimNumber: string;
  title: string;
  claimantId: string;
  claimantName: string;
  revision: number;
  /** The submission total: what was submitted for this decision. */
  amountMinor: number;
  currency: string;
}

export type QueueArgs =
  | {
      kind: 'PENDING';
      /** Half-open UTC range on activated_at (businessDayRangeToUtc). */
      range: { gte?: Date; lt?: Date };
      /** Keyset position: rows strictly after (activatedAt, id) in ASC order. */
      after?: { at: Date; id: string };
      take: number;
    }
  | {
      kind: 'DECIDED';
      statuses: readonly ('APPROVED' | 'REJECTED')[];
      /** Half-open UTC range on decided_at. */
      range: { gte?: Date; lt?: Date };
      /** Keyset position: rows strictly after (decidedAt, id) in DESC order. */
      after?: { at: Date; id: string };
      take: number;
    };

const QUEUE_COLUMNS = Prisma.sql`
  s.id AS "stepId", s.level::int AS level,
  (SELECT count(*)::int FROM public.approval_steps x WHERE x.submission_id = s.submission_id)
    AS "levelCount",
  s.tier_label AS "tierLabel", s.status::text AS status,
  s.activated_at AS "activatedAt", s.decided_at AS "decidedAt",
  c.id AS "claimId", c.claim_number AS "claimNumber", c.title,
  u.id AS "claimantId", u.name AS "claimantName",
  sub.revision, sub.total_minor AS "amountMinor", sub.currency`;

const QUEUE_FROM = Prisma.sql`
  FROM public.approval_steps s
  JOIN public.claim_submissions sub ON sub.id = s.submission_id
  JOIN public.claims c              ON c.id = s.claim_id
  JOIN public.users u               ON u.id = c.claimant_id`;

const DECIDED_STATUS: Record<string, Prisma.Sql> = {
  APPROVED: Prisma.sql`s.status = 'APPROVED'`,
  REJECTED: Prisma.sql`s.status = 'REJECTED'`,
  'APPROVED,REJECTED': Prisma.sql`s.status IN ('APPROVED', 'REJECTED')`,
};

/**
 * GET /api/v1/approvals (02 §5, 04 §5.4, §8.3): a query over MY steps, never over claims. The scope
 * `approver_id = me` is the first conjunct and never comes from input; WAITING and CANCELLED steps
 * are never listed. Keyset (`LIMIT take`, no OFFSET, no COUNT):
 * - PENDING: `activated_at ASC, id ASC` on the partial approval_steps_pending_queue_idx. The status
 *   is a SQL literal, not a bind parameter, so the planner can prove the partial-index predicate.
 * - decided: `decided_at DESC, id DESC` on approval_steps_approver_history_idx.
 * The row comparison `(col, id) > (v, id)` is an index condition, so any page is a range scan.
 */
export function listQueue(actor: Actor, a: QueueArgs): Promise<QueueRow[]> {
  const where: Prisma.Sql[] = [Prisma.sql`s.approver_id = ${actor.id}::uuid`];
  const col = a.kind === 'PENDING' ? Prisma.sql`s.activated_at` : Prisma.sql`s.decided_at`;
  if (a.kind === 'PENDING') {
    where.push(Prisma.sql`s.status = 'PENDING'`);
  } else {
    const key = [...new Set(a.statuses)].sort().join(',');
    const status = DECIDED_STATUS[key];
    if (!status) throw new RangeError(`Bad decided statuses: ${key}`);
    where.push(status, Prisma.sql`s.decided_at IS NOT NULL`);
  }
  // Instants travel as ISO strings with an explicit cast: no dependence on the session TimeZone.
  const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz`;
  if (a.range.gte) where.push(Prisma.sql`${col} >= ${ts(a.range.gte)}`);
  if (a.range.lt) where.push(Prisma.sql`${col} < ${ts(a.range.lt)}`);
  if (a.after)
    where.push(
      a.kind === 'PENDING'
        ? Prisma.sql`(s.activated_at, s.id) > (${ts(a.after.at)}, ${a.after.id}::uuid)`
        : Prisma.sql`(s.decided_at, s.id) < (${ts(a.after.at)}, ${a.after.id}::uuid)`,
    );
  const order =
    a.kind === 'PENDING'
      ? Prisma.sql`ORDER BY s.activated_at ASC, s.id ASC`
      : Prisma.sql`ORDER BY s.decided_at DESC, s.id DESC`;
  return getDb().$queryRaw<QueueRow[]>`
    SELECT ${QUEUE_COLUMNS} ${QUEUE_FROM}
     WHERE ${Prisma.join(where, ' AND ')}
     ${order}
     LIMIT ${a.take}`;
}
