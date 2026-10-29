import type { Metadata } from 'next';
import { z } from 'zod';
import { NotFoundView } from '@/components/common/not-found-view';
import { ClaimDetailView } from '@/features/claims/claim-detail-view';

export const metadata: Metadata = { title: 'Claim' };

const ClaimId = z.uuid();

/**
 * Thin page (05 §2.1): validate the id's shape, then hand over to the client screen, which reads
 * through /api/v1. A malformed id gets the same "Claim not found" view, without a request.
 */
export default async function ClaimPage({ params }: PageProps<'/claims/[id]'>) {
  const { id } = await params;
  if (!ClaimId.safeParse(id).success) return <NotFoundView kind="claim" />;
  return <ClaimDetailView claimId={id} context="owner" />;
}
