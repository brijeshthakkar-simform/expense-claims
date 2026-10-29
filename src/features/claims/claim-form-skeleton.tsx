import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder while the claim or the categories load (~100 ms, 05 §2.1). */
export function ClaimFormSkeleton({ header = false }: { header?: boolean }) {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      {header && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-80 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      )}
      <Skeleton className="h-9 w-full max-w-xl" />
      <div className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
      <Skeleton className="h-9 w-40" />
    </div>
  );
}
