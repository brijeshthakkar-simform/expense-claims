'use client';

import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { ErrorReference } from '@/components/common/error-reference';
import { Button } from '@/components/ui/button';

/**
 * Render errors inside the shell (the nav stays usable). API errors don't land here: queries show
 * their own error views; this catches bugs and server-component failures.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => console.error(error), [error]);

  return (
    <section
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center"
    >
      <AlertTriangle aria-hidden className="text-destructive size-10" />
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground text-sm">
        This page couldn&apos;t be displayed. Try again; if it keeps happening, contact support with
        the reference below.
      </p>
      <ErrorReference id={error.digest} />
      <Button type="button" onClick={() => retry()} className="mt-2">
        Try again
      </Button>
    </section>
  );
}
