'use client';

import { AlertTriangle } from 'lucide-react';
import { ErrorReference } from '@/components/common/error-reference';
import { Button } from '@/components/ui/button';
import { describeApiError } from '@/lib/api-client';

/**
 * A query that failed for a reason other than "not found" or "forbidden" (05 §5.2): the copy, a
 * Retry, and the reference.
 */
export function QueryErrorView({
  error,
  onRetry,
  title = 'This couldn’t be loaded',
  level = 1,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  /** 2 when the page already has its own h1. */
  level?: 1 | 2;
}) {
  const d = describeApiError(error);
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center"
    >
      <AlertTriangle aria-hidden className="text-destructive size-10" />
      <Heading className="text-xl font-semibold">{title}</Heading>
      <p className="text-muted-foreground text-sm">{d.title}</p>
      <ErrorReference id={d.requestId} />
      {onRetry && (
        <Button type="button" variant="outline" onClick={onRetry} className="mt-2">
          Retry
        </Button>
      )}
    </section>
  );
}
