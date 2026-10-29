import 'server-only';

// 04 §2.5. One name function shared by authenticate(), the cookie writer, getActor() and
// proxy.ts, so the three can never disagree (R-24).

const isHttps = (appBaseUrl: string) => /^https:\/\//i.test(appBaseUrl);

/** `__Host-ec_session` when APP_BASE_URL is https (forces Secure, Path=/, no Domain), else `ec_session`. */
export function sessionCookieName(appBaseUrl: string): string {
  return isHttps(appBaseUrl) ? '__Host-ec_session' : 'ec_session';
}

const attributes = (appBaseUrl: string, maxAgeSeconds: number) =>
  ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
    .concat(isHttps(appBaseUrl) ? ['Secure'] : [])
    .join('; ');

/** The Set-Cookie value for a fresh session. Max-Age is the absolute lifetime (12 h → 43200). */
export function sessionCookie(token: string, appBaseUrl: string, maxAgeSeconds: number): string {
  return `${sessionCookieName(appBaseUrl)}=${token}; ${attributes(appBaseUrl, maxAgeSeconds)}`;
}

/** Same name and attributes with Max-Age=0: the browser drops the cookie. */
export function clearedSessionCookie(appBaseUrl: string): string {
  return `${sessionCookieName(appBaseUrl)}=; ${attributes(appBaseUrl, 0)}`;
}

/** The raw session token from a NextRequest-like cookie jar (never from next/headers). */
export function readSessionToken(
  cookies: { get(name: string): { value: string } | undefined },
  appBaseUrl: string,
): string | undefined {
  return cookies.get(sessionCookieName(appBaseUrl))?.value || undefined;
}
