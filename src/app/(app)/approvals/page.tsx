import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListSkeleton } from '@/components/lists/list-skeleton';
import { ApprovalsScreen } from '@/features/approvals/approvals-screen';

export const metadata: Metadata = { title: 'Approvals' };

/** Thin page (05 §2.1): tabs and dates come from the URL, rows from GET /api/v1/approvals. */
export default function ApprovalsPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-muted-foreground text-sm">
          Claims routed to you for a decision, and the ones you have decided.
        </p>
      </div>
      {/* useSearchParams consumers sit inside <Suspense> so the shell can prerender (05 §10.1). */}
      <Suspense fallback={<ListSkeleton />}>
        <ApprovalsScreen />
      </Suspense>
    </div>
  );
}
