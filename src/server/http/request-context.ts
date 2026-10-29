import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextRequest } from 'next/server';
import { callMeta } from '@/server/http/call-meta';
import { REQUEST_ID_PATTERN } from '@/shared/policy';

// 06 §2.2. Every log line inside a request gets requestId/userId/route from this store via the
// logger mixin, without passing loggers around. This module imports nothing from logging/ (the
// logger imports the store), so there is no import cycle.

export interface RequestContext {
  requestId: string;
  /** `METHOD /path`, never the query string. */
  route: string;
  /** Set by defineRoute right after authentication (or by login once the user is known). */
  userId?: string;
  startedAt: number;
  ip: string | null;
  userAgent: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * An inbound x-request-id is kept for cross-service correlation only if it matches
 * ^[A-Za-z0-9-]{8,64}$ (claim_events.request_id is varchar(64); log lines must not be injectable).
 * Anything else is replaced, never rejected.
 */
export const resolveRequestId = (inbound: string | null | undefined): string =>
  inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();

/**
 * Step 1 of defineRoute: runs `fn` inside a fresh request context and echoes the id on the
 * response. Everything awaited inside (services, Prisma, the logger) sees the store.
 */
export function withRequestContext(
  req: NextRequest,
  fn: (rc: RequestContext) => Promise<Response>,
): Promise<Response> {
  const rc: RequestContext = {
    requestId: resolveRequestId(req.headers.get('x-request-id')),
    route: `${req.method} ${req.nextUrl.pathname}`,
    startedAt: performance.now(),
    ...callMeta(req),
  };
  return requestContext.run(rc, async () => {
    const res = await fn(rc);
    res.headers.set('x-request-id', rc.requestId);
    return res;
  });
}

/** The current request's context, if any (undefined outside a request, e.g. at boot). */
export const currentRequestContext = (): RequestContext | undefined => requestContext.getStore();

/** Attributes the rest of this request's log lines to `userId` (login, once the user is known). */
export function bindUserToRequest(userId: string): void {
  const rc = requestContext.getStore();
  if (rc) rc.userId = userId;
}
