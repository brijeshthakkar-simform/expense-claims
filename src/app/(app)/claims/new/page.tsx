import type { Metadata } from 'next';
import { NewClaimScreen } from '@/features/claims/new-claim-screen';

export const metadata: Metadata = { title: 'New claim' };

// Thin page (05 §2.1): no reads here; the screen fetches categories through /api/v1.
export default function NewClaimPage() {
  return <NewClaimScreen />;
}
