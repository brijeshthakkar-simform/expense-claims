import { ShieldX } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Role-section mismatch (e.g. a non-finance user opening /finance/…) or an API FORBIDDEN on a query.
 * A UX gate only: the API's 403 is the real boundary.
 */
export function ForbiddenView({
  area,
  level = 1,
}: {
  area: string;
  /** 2 when the page already has its own h1 (a list inside a section page). */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section
      aria-labelledby="forbidden-title"
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center"
    >
      <ShieldX aria-hidden className="text-muted-foreground size-10" />
      <Heading id="forbidden-title" className="text-xl font-semibold">
        You don&apos;t have access to {area}.
      </Heading>
      <p className="text-muted-foreground text-sm">
        If you think you should, ask your administrator.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/claims">Go to My claims</Link>
      </Button>
    </section>
  );
}
