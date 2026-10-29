import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListSkeleton } from '@/components/lists/list-skeleton';
import { FinanceClaimsScreen } from '@/features/finance/finance-claims-screen';

export const metadata: Metadata = { title: 'Finance claims' };

/** Thin page (05 §2.1, §11): filters come from the URL, rows from GET /api/v1/finance/claims. */
export default function FinanceClaimsPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Finance claims</h1>
        <p className="text-muted-foreground text-sm">
          Every employee’s claims, read-only. Drafts are hidden unless you ask for them.
        </p>
      </div>
      {/* useSearchParams consumers sit inside <Suspense> so the shell can prerender (05 §10.1). */}
      <Suspense fallback={<ListSkeleton />}>
        <FinanceClaimsScreen />
      </Suspense>
    </div>
  );
}
