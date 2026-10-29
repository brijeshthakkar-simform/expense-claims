'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMe } from '@/components/app-shell/actor-provider';
import { cn } from '@/lib/utils';
import type { MeDto } from '@/shared/dto/auth';

interface NavItem {
  href: string;
  label: string;
  show: (me: MeDto) => boolean;
}

// 05 §3. Driven by MeDto capability flags only, never by claim data.
const NAV: NavItem[] = [
  { href: '/claims', label: 'My claims', show: () => true },
  { href: '/claims/new', label: 'New claim', show: () => true },
  { href: '/approvals', label: 'Approvals', show: (me) => me.canApprove && !me.isFinance },
  { href: '/finance/claims', label: 'Finance claims', show: (me) => me.isFinance },
  { href: '/finance/export', label: 'Export', show: (me) => me.isFinance },
];

const matches = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** The longest matching href wins, so /claims/new marks "New claim" and not "My claims" too. */
const activeHref = (pathname: string, items: NavItem[]) =>
  items
    .filter((item) => matches(pathname, item.href))
    .reduce<string | null>(
      (best, { href }) => (best && best.length >= href.length ? best : href),
      null,
    );

export function NavLinks() {
  const me = useMe();
  const pathname = usePathname();
  const items = NAV.filter((item) => item.show(me));
  const current = activeHref(pathname, items);
  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap items-center gap-1">
        {items.map(({ href, label }) => {
          const active = href === current;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-ring/50 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]',
                  active
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
