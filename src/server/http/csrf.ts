import 'server-only';
import type { NextRequest } from 'next/server';
import { env } from '@/server/env';
import { AppError } from '@/server/errors/app-error';

// 04 §2.6 / D-06. Layered with SameSite=Lax, JSON-only bodies (defineRoute: 415) and no CORS
// headers anywhere. No tokens to plumb through React.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The only GET with weight (a 366-day stream): Lax cookies ride on top-level cross-site GETs. */
const CROSS_SITE_GET_DENYLIST = new Set(['/api/v1/finance/exports/approved-claims']);

export const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method.toUpperCase());

/**
 * 403 CSRF_REJECTED when an unsafe method carries an Origin other than APP_BASE_URL's, or a
 * Sec-Fetch-Site other than same-origin/none. No Origin at all (curl, server-to-server) is allowed:
 * such a caller carries no ambient browser cookie.
 */
export function assertSameOrigin(req: NextRequest): void {
  const site = req.headers.get('sec-fetch-site');
  if (isSafeMethod(req.method)) {
    if (CROSS_SITE_GET_DENYLIST.has(req.nextUrl.pathname) && site === 'cross-site')
      throw new AppError('CSRF_REJECTED');
    return;
  }
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(env().APP_BASE_URL).origin) throw new AppError('CSRF_REJECTED');
  if (site && site !== 'same-origin' && site !== 'none') throw new AppError('CSRF_REJECTED');
}
