import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ListSkeleton } from '@/components/lists/list-skeleton';
import { Button } from '@/components/ui/button';
import { MyClaimsScreen } from '@/features/claims/my-claims-screen';

export const metadata: Metadata = { title: 'My claims' };

/** Thin page (05 §2.1): the list reads its filters from the URL and its rows from /api/v1. */
export default function MyClaimsPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">My claims</h1>
        <Button asChild>
          <Link href="/claims/new">
            <Plus aria-hidden />
            New claim
          </Link>
        </Button>
      </div>
      {/* useSearchParams consumers sit inside <Suspense> so the shell can prerender (05 §10.1). */}
      <Suspense fallback={<ListSkeleton />}>
        <MyClaimsScreen />
      </Suspense>
    </div>
  );
}
