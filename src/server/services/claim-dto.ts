import 'server-only';
import type { Actor } from '@/server/auth/actor';
import { allowedActions, submissionOutcome } from '@/server/authz/claim-policy';
import type { CategoryRow } from '@/server/repositories/categories.repo';
import type { ReceiptDtoRow } from '@/server/repositories/receipts.repo';
import type {
  ClaimDetailRow,
  ClaimHistoryRow,
  ClaimSummaryRow,
  StepDtoRow,
} from '@/server/repositories/claims.repo';
import type { FinanceListRow } from '@/server/repositories/finance.repo';
import { ymdOfDateOnly } from '@/shared/dates';
import type { CategoryDto } from '@/shared/dto/categories';
import type {
  ApprovalStepDto,
  ClaimDetail,
  ClaimSummary,
  LastRejection,
  ReceiptDto,
} from '@/shared/dto/claims';
import type { FinanceClaimSummary } from '@/shared/dto/finance';
import type { ClaimHistory } from '@/shared/dto/history';
import { SnapshotV1 } from '@/shared/dto/snapshot';

// Rows → wire DTOs (C-10). Instants become UTC ISO strings, `date` columns YYYY-MM-DD. The total is
// copied from the row Postgres returned; nothing here computes one.

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toCategoryDto = (c: CategoryRow): CategoryDto => ({
  id: c.id,
  code: c.code,
  name: c.name,
  isActive: c.isActive,
});

export const toReceiptDto = (r: ReceiptDtoRow): ReceiptDto => ({
  id: r.id,
  fileName: r.fileName,
  contentType: r.contentType,
  sizeBytes: r.sizeBytes,
  createdAt: r.createdAt.toISOString(),
});

const toStepDto = (st: StepDtoRow): ApprovalStepDto => ({
  level: st.level,
  tierCode: st.tierCode,
  tierLabel: st.tierLabel,
  approver: { id: st.approver.id, name: st.approver.name },
  status: st.status,
  activatedAt: iso(st.activatedAt),
  decidedAt: iso(st.decidedAt),
  comment: st.comment,
  rejectionReason: st.rejectionReason,
});

function toLastRejection(row: ClaimDetailRow): LastRejection | null {
  const r = row.approvalSteps[0];
  // CHECK steps_decided_iff / steps_reason_iff_rejected: a REJECTED step has both.
  if (!r?.decidedAt || r.rejectionReason === null) return null;
  return {
    revision: r.submission.revision,
    level: r.level,
    reason: r.rejectionReason,
    by: { id: r.approver.id, name: r.approver.name },
    at: r.decidedAt.toISOString(),
  };
}

export function toClaimDetail(actor: Actor, row: ClaimDetailRow): ClaimDetail {
  const sub = row.currentSubmission;
  // My step on the current submission (one person signs at most one level of a submission).
  const myStep = sub?.steps.find((s) => s.approver.id === actor.id)?.status ?? null;
  return {
    id: row.id,
    claimNumber: row.claimNumber,
    title: row.title,
    status: row.status,
    currency: row.currency,
    totalMinor: row.totalMinor,
    currentRevision: row.currentRevision,
    claimant: { id: row.claimant.id, name: row.claimant.name },
    createdAt: row.createdAt.toISOString(),
    submittedAt: iso(row.submittedAt),
    approvedAt: iso(row.approvedAt),
    rejectedAt: iso(row.rejectedAt),
    lineItems: row.lineItems.map((li) => ({
      id: li.id,
      expenseDate: ymdOfDateOnly(li.expenseDate),
      category: toCategoryDto(li.category),
      amountMinor: li.amountMinor,
      description: li.description,
      merchant: li.merchant,
      receipts: li.receipts.map(toReceiptDto),
    })),
    approval: sub && {
      revision: sub.revision,
      steps: sub.steps.map(toStepDto),
    },
    lastRejection: toLastRejection(row),
    allowedActions: allowedActions(actor, {
      status: row.status,
      claimantId: row.claimantId,
      currentRevision: row.currentRevision,
      myStepOnCurrentRevision: myStep,
    }),
  };
}

export const toClaimSummary = (row: ClaimSummaryRow): ClaimSummary => ({
  id: row.id,
  claimNumber: row.claimNumber,
  title: row.title,
  status: row.status,
  currency: row.currency,
  totalMinor: row.totalMinor,
  currentRevision: row.currentRevision,
  lineItemCount: row.lineItemCount,
  createdAt: row.createdAt.toISOString(),
  submittedAt: iso(row.submittedAt),
  approvedAt: iso(row.approvedAt),
});

/** A finance list row: the summary plus who claimed it (finance reads every employee's claims). */
export const toFinanceClaimSummary = (row: FinanceListRow): FinanceClaimSummary => ({
  id: row.id,
  claimNumber: row.claimNumber,
  title: row.title,
  status: row.status,
  currency: row.currency,
  totalMinor: row.totalMinor,
  currentRevision: row.currentRevision,
  lineItemCount: row.lineItemCount,
  claimant: { id: row.claimantId, name: row.claimantName, email: row.claimantEmail },
  createdAt: row.createdAt.toISOString(),
  submittedAt: iso(row.submittedAt),
  approvedAt: iso(row.approvedAt),
});

/**
 * GET …/history (02 §10.5). Each submission's outcome is derived from its steps (D-18); the
 * snapshot is parsed against C-21, so a stored row that drifted from the contract is a 500, never
 * a silently different shape.
 */
export const toClaimHistory = (row: ClaimHistoryRow): ClaimHistory => ({
  submissions: row.submissions.map((s) => ({
    revision: s.revision,
    submittedAt: s.submittedAt.toISOString(),
    totalMinor: s.totalMinor,
    lineItemCount: s.lineItemCount,
    outcome: submissionOutcome(s.steps),
    snapshot: SnapshotV1.parse(s.snapshot),
    steps: s.steps.map(toStepDto),
  })),
  events: row.events.map((e) => ({
    id: e.id,
    type: e.type,
    occurredAt: e.occurredAt.toISOString(),
    actor: { id: e.actor.id, name: e.actor.name },
    actorRole: e.actorRole,
    revision: e.revision,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    reason: e.reason,
    payload: e.payload as Record<string, unknown>, // a JSON object (CHECK claim_events_payload_object)
    requestId: e.requestId,
  })),
});
