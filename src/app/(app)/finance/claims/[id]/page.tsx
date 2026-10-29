import type { Metadata } from 'next';
import { z } from 'zod';
import { NotFoundView } from '@/components/common/not-found-view';
import { ClaimDetailView } from '@/features/claims/claim-detail-view';

export const metadata: Metadata = { title: 'Claim' };

const ClaimId = z.uuid();

/**
 * Thin page (05 §2.1, §11): the same ClaimDetailView as the owner and approver pages, in the
 * finance context ("Read-only (Finance)" chip, receipt downloads). Finance on someone else's claim
 * gets `allowedActions: []` from the server, so no action renders. A malformed id gets the same
 * "Claim not found" view, without a request.
 */
export default async function FinanceClaimPage({ params }: PageProps<'/finance/claims/[id]'>) {
  const { id } = await params;
  if (!ClaimId.safeParse(id).success) return <NotFoundView kind="claim" />;
  return <ClaimDetailView claimId={id} context="finance" />;
}
