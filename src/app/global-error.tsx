'use client';

import { useEffect } from 'react';
import './globals.css';

/**
 * Last-resort boundary: replaces the root layout when it (or <Providers>) throws, so it renders
 * its own document and can't rely on any provider. `digest` matches the server log entry.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => console.error(error), [error]);

  return (
    <html lang="en-IN" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <title>Something went wrong · Expense Claims</title>
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground max-w-md text-sm">
          The page couldn&apos;t be displayed. Try again; if it keeps happening, contact support
          with the reference below.
        </p>
        {error.digest && (
          <p className="text-muted-foreground text-xs">
            Reference: <code className="font-mono select-all">{error.digest}</code>
          </p>
        )}
        <button
          type="button"
          onClick={() => retry()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 mt-2 h-9 rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-[3px]"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
