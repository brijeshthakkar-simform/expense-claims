import { Receipt } from 'lucide-react';
import Link from 'next/link';
import { NavLinks } from '@/components/app-shell/nav-links';
import { UserMenu } from '@/components/app-shell/user-menu';

/** Top bar (product, nav, user menu), the page, and the IST footer (05 §3). */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <a
        href="#main"
        className="bg-background focus-visible:ring-ring/50 sr-only z-50 rounded-md px-3 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus-visible:ring-[3px]"
      >
        Skip to main content
      </a>
      <header className="bg-background border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link
              href="/claims"
              className="focus-visible:ring-ring/50 flex items-center gap-2 rounded-md font-semibold outline-none focus-visible:ring-[3px]"
            >
              <Receipt aria-hidden className="size-5" />
              Expense Claims
            </Link>
            <NavLinks />
          </div>
          <UserMenu />
        </div>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none"
      >
        {children}
      </main>
      <footer className="text-muted-foreground border-t">
        <p className="mx-auto max-w-6xl px-4 py-3 text-xs">All times in IST</p>
      </footer>
    </div>
  );
}
