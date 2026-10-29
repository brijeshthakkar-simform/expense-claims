import { NextResponse, type NextRequest } from 'next/server';
import { PAGE_PATH_HEADER } from '@/lib/navigation';
import { sessionCookieName } from '@/server/auth/cookie';
import { env } from '@/server/env';
import { PUBLIC_PAGES } from '@/server/http/public-routes';

/**
 * Optimistic page redirect only (01 §9.5, D-07): a page request without a session cookie goes to
 * /login?next=<path>. It checks cookie *presence*, never validity, and its matcher skips /api, so
 * deleting this file changes nothing about security: `(app)/layout.tsx` re-checks the session and
 * every route handler authenticates on its own.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if ((PUBLIC_PAGES as readonly string[]).includes(pathname)) return NextResponse.next();

  if (req.cookies.has(sessionCookieName(env().APP_BASE_URL))) {
    // Lets the (app) layout send an expired session to /login?next=<this page>.
    const headers = new Headers(req.headers);
    headers.set(PAGE_PATH_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
  }

  const login = new URL('/login', req.url);
  login.searchParams.set('next', pathname + search); // the login page accepts only a local path
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
