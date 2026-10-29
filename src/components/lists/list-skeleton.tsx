import { Skeleton } from '@/components/ui/skeleton';

/** Suspense fallback for a list page while its URL filters are read (filter bar + rows). */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading list" className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-72" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
