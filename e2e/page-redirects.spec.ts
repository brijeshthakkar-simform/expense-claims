import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// TC-E04 (05 §15.3), the page half of §6-3 and the only test of the (app) layout redirect: every
// page in C-07 sends a visitor without a session to /login?next=<that page>. Two ways in: no
// cookie at all (src/proxy.ts checks presence), and a cookie whose session doesn't exist (proxy
// lets it through; `(app)/layout.tsx` finds no session and redirects). Never cut (C-24).
const id = randomUUID();
const PAGES = [
  '/',
  '/claims',
  '/claims?status=DRAFT',
  '/claims/new',
  `/claims/${id}`,
  '/approvals',
  '/approvals?status=APPROVED,REJECTED',
  `/approvals/${id}`,
  '/finance/claims',
  `/finance/claims/${id}`,
  '/finance/export',
];

/** A path with its query decoded, so `?status=A,B` and `?status=A%2CB` compare equal. */
const normalise = (path: string | null): string | null => {
  if (path === null) return null;
  const url = new URL(path, 'http://same-origin.invalid');
  return `${url.pathname}?${[...url.searchParams].map(([k, v]) => `${k}=${v}`).join('&')}`;
};

test('every (app) page redirects to /login without a session', async ({
  page,
  context,
  baseURL,
}) => {
  const expectLoginFor = async (path: string, how: string) => {
    await page.goto(path);
    await expect(page, `${path} (${how})`).toHaveURL(
      (url) =>
        url.pathname === '/login' && normalise(url.searchParams.get('next')) === normalise(path),
    );
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  };

  expect(await context.cookies()).toEqual([]);
  for (const path of PAGES) await expectLoginFor(path, 'no cookie');

  // A forged token: present (so proxy.ts passes it on) but matching no session row.
  const https = baseURL?.startsWith('https:') ?? false;
  await context.addCookies([
    {
      name: https ? '__Host-ec_session' : 'ec_session',
      value: 'forged-token-that-matches-no-session',
      url: baseURL!,
      ...(https && { secure: true }),
    },
  ]);
  for (const path of PAGES) await expectLoginFor(path, 'forged cookie');
});
