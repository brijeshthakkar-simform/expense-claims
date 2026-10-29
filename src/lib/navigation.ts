/** Page-navigation helpers shared by proxy.ts, the layouts, the login form and the api client. */

/** Where a signed-in user lands when there is no (valid) `next` target. */
export const DEFAULT_LANDING = '/claims';

/**
 * Request header that src/proxy.ts sets to the page path (+ query) so `(app)/layout.tsx` can build
 * `/login?next=…` when a session cookie is present but no longer valid. Proxy always overwrites it,
 * and its value is only ever used through `safeNext`, so a client-supplied copy can't redirect
 * anywhere off-site.
 */
export const PAGE_PATH_HEADER = 'x-ec-page-path';

const PROBE_ORIGIN = 'http://same-origin.invalid';
const isLoginPath = (path: string) => /^\/login(?:[/?#]|$)/.test(path);

/**
 * Open-redirect guard for `?next=` (05 §4.2). Accepts only a same-origin path that isn't the login
 * page itself. The prefix checks reject `//host` and `/\host`; resolving against a fixed origin
 * then catches what browsers normalise later (`/\t/evil.example` loses the tab → `//evil.example`).
 */
export function safeNext(raw: unknown, fallback: string = DEFAULT_LANDING): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  try {
    const url = new URL(raw, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return fallback;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return isLoginPath(path) ? fallback : path;
  } catch {
    return fallback;
  }
}

/** `/login?next=<path>`, the shape src/proxy.ts builds; plain `/login` when `next` is unusable. */
export function loginHref(next?: string | null): string {
  const target = safeNext(next, '');
  return target ? `/login?next=${encodeURIComponent(target)}` : '/login';
}

/**
 * A full document navigation, deliberately not the client router: it drops the QueryClient and
 * every in-memory claim, and makes the next page re-run its server-side session check. Used only
 * across a sign-in boundary (after login, after logout, on a 401).
 */
export function hardNavigate(path: string): void {
  window.location.assign(path);
}
