'use client';

import { DecisionPanel } from '@/features/approvals/decision-panel';
import { ClaimDetailView } from '@/features/claims/claim-detail-view';
import type { ClaimDetail } from '@/shared/dto/claims';

const renderDecision = (claim: ClaimDetail) => <DecisionPanel claim={claim} />;

/**
 * /approvals/[claimId] (05 §4.2): the same ClaimDetailView as the owner and finance pages, in the
 * approver context, with the decision panel in its slot. A claim outside my scope is the API's
 * 404, rendered as the same "Claim not found" view (F9).
 */
export function ApprovalReviewScreen({ claimId }: { claimId: string }) {
  return <ClaimDetailView claimId={claimId} context="approver" decision={renderDecision} />;
}
