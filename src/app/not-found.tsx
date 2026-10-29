import type { Metadata } from 'next';
import { NotFoundView } from '@/components/common/not-found-view';

export const metadata: Metadata = { title: 'Page not found' };

/** Unknown pages. In-page "Claim not found" is <NotFoundView kind="claim"> inside the shell. */
export default function NotFound() {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-4">
      <NotFoundView kind="page" />
    </main>
  );
}
