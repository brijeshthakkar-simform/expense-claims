'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import {
  ApiError,
  describeApiError,
  handleUnauthenticated,
  isUnauthenticated,
} from '@/lib/api-client';

declare module '@tanstack/react-query' {
  interface Register {
    // A mutation that renders its own error UX (form alert, dialog, banner) sets
    // `meta: { handlesErrors: true }` so the global toast stays quiet.
    mutationMeta: { handlesErrors?: boolean };
  }
}

function makeQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (e) => {
        if (isUnauthenticated(e)) handleUnauthenticated(queryClient);
      },
    }),
    mutationCache: new MutationCache({
      onError: (e, _vars, _ctx, mutation) => {
        if (isUnauthenticated(e)) return handleUnauthenticated(queryClient);
        if (mutation.options.meta?.handlesErrors) return;
        const d = describeApiError(e);
        toast.error(d.title, { description: d.reference });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true, // an approver returning to the tab sees a fresh queue
        // A 4xx is an answer, not a glitch: a foreign claim's 404 must show "not found" at once.
        retry: (count, e) =>
          !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
      },
      mutations: { retry: false }, // never auto-retry a state transition (F2)
    },
  });
  return queryClient;
}

/** Client-side providers for every page, /login included (05 §2.2–§2.3). */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Light only for now: dark mode is OPTIONAL (05 §12). */}
      <Toaster theme="light" richColors closeButton />
    </QueryClientProvider>
  );
}
