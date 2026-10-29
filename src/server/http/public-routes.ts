import 'server-only';

/**
 * The ONE allowlist of unauthenticated API routes (04 §3.3), as `METHOD /path` keys in the
 * route-inventory format. TC-I01 asserts that exactly these handlers are `auth: 'public'`.
 */
export const PUBLIC_ROUTES = [
  'POST /api/v1/auth/login',
  'GET /api/health/live',
  'GET /api/health/ready',
] as const;
export type PublicRoute = (typeof PUBLIC_ROUTES)[number];

/** Pages reachable without a session; proxy.ts never redirects these to /login. */
export const PUBLIC_PAGES = ['/login'] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];
