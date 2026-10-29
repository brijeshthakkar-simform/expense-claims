import { FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const COPY = {
  // Same words for "doesn't exist" and "not yours": the UI mirrors the API's 404 (F9).
  claim: {
    title: 'Claim not found',
    body: "It may not exist, or it isn't shared with you.",
  },
  page: {
    title: 'Page not found',
    body: "The address may be mistyped, or the page doesn't exist.",
  },
} as const;

export function NotFoundView({ kind = 'page' }: { kind?: keyof typeof COPY }) {
  const { title, body } = COPY[kind];
  return (
    <section
      aria-labelledby="not-found-title"
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center"
    >
      <FileQuestion aria-hidden className="text-muted-foreground size-10" />
      <h1 id="not-found-title" className="text-xl font-semibold">
        {title}
      </h1>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/claims">Go to My claims</Link>
      </Button>
    </section>
  );
}
