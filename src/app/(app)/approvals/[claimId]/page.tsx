import type { Metadata } from 'next';
import { z } from 'zod';
import { NotFoundView } from '@/components/common/not-found-view';
import { ApprovalReviewScreen } from '@/features/approvals/approval-review-screen';

export const metadata: Metadata = { title: 'Review claim' };

const ClaimId = z.uuid();

/**
 * Thin page (05 §2.1): validate the id's shape, then hand over to the client screen, which reads
 * through /api/v1. A malformed id gets the same "Claim not found" view, without a request.
 */
export default async function ApprovalReviewPage({ params }: PageProps<'/approvals/[claimId]'>) {
  const { claimId } = await params;
  if (!ClaimId.safeParse(claimId).success) return <NotFoundView kind="claim" />;
  return <ApprovalReviewScreen claimId={claimId} />;
}
