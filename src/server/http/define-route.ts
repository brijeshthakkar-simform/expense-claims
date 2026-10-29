import 'server-only';
import type { NextRequest } from 'next/server';
import type { z } from 'zod';
import { passesGate, type Actor, type Gate } from '@/server/auth/actor';
import { clearedSessionCookie, readSessionToken } from '@/server/auth/cookie';
import { authenticate } from '@/server/auth/session';
import { readSqlState } from '@/server/db/pg-error';
import { env } from '@/server/env';
import { AppError } from '@/server/errors/app-error';
import type { ErrorCode } from '@/server/errors/codes';
import { errorBody, isDbBackstop, mapError } from '@/server/errors/map-error';
import { assertSameOrigin, isSafeMethod } from '@/server/http/csrf';
import { withRequestContext, type RequestContext } from '@/server/http/request-context';
import { logger } from '@/server/logging/logger';
import type { ServiceCtx } from '@/server/services/context';
import { MAX_JSON_BODY_BYTES } from '@/shared/policy';

// 04 §3.2: every route handler is `export const METHOD = defineRoute({...})`, so authentication,
// CSRF, the role gate, validation, error mapping, request ids and the access log come for free and
// TC-I01 can prove it by reading ROUTE_META off every export.
//
// Pipeline: 1 request id + ALS → 2 authenticate (401) → 3 CSRF (403) → 4 role gate (403) →
// 5 path params (404) → 6 content type + size (415/413) → 7 query + body Zod (422; 400 bad JSON)
// → handler → error mapping → x-request-id + no-store → one `http.request` access line.

export const ROUTE_META = Symbol.for('expense.routeMeta');

export type AuthMode = 'required' | 'public';

export interface RouteMeta {
  auth: AuthMode;
  roles: readonly Gate[];
}

type SegmentParams = Record<string, string | string[] | undefined>;

/** The second argument Next passes to a route handler (optional, so a bare `GET(req)` works). */
export interface SegmentContext {
  params?: Promise<SegmentParams> | SegmentParams;
}

export type RouteHandler = ((req: NextRequest, segment?: SegmentContext) => Promise<Response>) & {
  readonly [ROUTE_META]: RouteMeta;
};

export interface RouteCtx<A extends AuthMode, P, Q, B> {
  req: NextRequest;
  /** The authenticated actor (null on public routes). */
  actor: A extends 'required' ? Actor : null;
  /** `{ actor, requestId }` for the service call (C-26); null on public routes. */
  serviceCtx: A extends 'required' ? ServiceCtx : null;
  params: P;
  query: Q;
  body: B;
  requestId: string;
  /** The raw session cookie value as presented (logout and login need it). */
  sessionToken: string | undefined;
}

export interface RouteSpec<A extends AuthMode, P, Q, B> {
  auth: A;
  /** Persona gates, all required, checked before any query (D-25). */
  roles?: readonly Gate[];
  params?: z.ZodType<P>;
  query?: z.ZodType<Q>;
  /** A strict Zod schema for a JSON body, or 'multipart' (the receipt upload reads formData). */
  body?: z.ZodType<B> | 'multipart';
  handler: (ctx: RouteCtx<A, P, Q, B>) => Promise<Response> | Response;
}

/** A malformed path id is Not Found for that resource (04 §6.1, step 4 of the ladder). */
const PARAM_NOT_FOUND: Record<string, ErrorCode> = {
  claimId: 'CLAIM_NOT_FOUND',
  lineItemId: 'LINE_ITEM_NOT_FOUND',
  receiptId: 'RECEIPT_NOT_FOUND',
};

/** Logged as `authz.denied` (warn): repeated hits are an id-probing signal (06 §2.6). */
const DENIAL_CODES = new Set<ErrorCode>([
  'UNAUTHENTICATED',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'NOT_IN_YOUR_QUEUE',
  'CLAIM_NOT_FOUND',
  'LINE_ITEM_NOT_FOUND',
  'RECEIPT_NOT_FOUND',
]);

export function defineRoute<A extends AuthMode, P = undefined, Q = undefined, B = undefined>(
  spec: RouteSpec<A, P, Q, B>,
): RouteHandler {
  const meta: RouteMeta = Object.freeze({
    auth: spec.auth,
    roles: Object.freeze([...(spec.roles ?? [])]),
  });

  const route = (req: NextRequest, segment?: SegmentContext): Promise<Response> =>
    withRequestContext(req, async (rc) => {
      let res: Response;
      let rawParams: SegmentParams | undefined;
      try {
        const appBaseUrl = env().APP_BASE_URL;
        const sessionToken = readSessionToken(req.cookies, appBaseUrl);

        const actor = spec.auth === 'required' ? await authenticate(req) : null; // 2. 401
        if (actor) rc.userId = actor.id;
        assertSameOrigin(req); // 3. 403 CSRF_REJECTED
        if (actor && spec.roles?.some((g) => !passesGate(actor, g)))
          throw new AppError('FORBIDDEN'); // 4. role gate, before any query

        rawParams = (await segment?.params) ?? {};
        const params = parseParams(spec.params, rawParams); // 5. 404 <RESOURCE>_NOT_FOUND
        const rawBody = await readBody(req, spec.body); // 6. 415 / 413
        const query = parse(spec.query, Object.fromEntries(req.nextUrl.searchParams)); // 7. 422
        const body = parseBody(spec.body, rawBody); // 400 MALFORMED_JSON / 422

        const serviceCtx: ServiceCtx | null = actor && { actor, requestId: rc.requestId };
        res = await spec.handler({
          req,
          actor,
          serviceCtx,
          params,
          query,
          body,
          requestId: rc.requestId,
          sessionToken,
        } as RouteCtx<A, P, Q, B>);
      } catch (err) {
        res = errorResponse(err, req, rc, rawParams);
      }
      res = withHeaders(res, { 'x-request-id': rc.requestId, 'cache-control': 'no-store' });
      logAccess(rc, res);
      return res;
    });

  Object.defineProperty(route, ROUTE_META, { value: meta, enumerable: false });
  return route as RouteHandler;
}

// ------------------------------------------------------------------------------------- parsing

function parse<T>(schema: z.ZodType<T> | undefined, value: unknown): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(value);
  if (!r.success) throw r.error; // mapError: TOTAL_IS_DERIVED / READ_ONLY_FIELD / VALIDATION_FAILED
  return r.data;
}

function parseParams<P>(schema: z.ZodType<P> | undefined, raw: SegmentParams): P {
  if (!schema) return undefined as P;
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const key = r.error.issues.map((i) => String(i.path[0])).find((k) => k in PARAM_NOT_FOUND);
  throw new AppError(key ? PARAM_NOT_FOUND[key]! : 'ROUTE_NOT_FOUND');
}

const isJsonType = (contentType: string | null) =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
const isMultipartType = (contentType: string | null) =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'multipart/form-data';

/**
 * Step 6. Safe methods never read a body. Unsafe ones: 'multipart' routes need multipart/form-data
 * and parse it themselves; every other route reads at most 256 KiB, and a non-empty body must be
 * application/json (D-06: HTML forms can't send JSON cross-site). Empty bodies are fine, so a
 * bodyless POST (logout, submit) needs no content type. Returns the raw text ('' = no body).
 */
async function readBody(req: NextRequest, spec: z.ZodType | 'multipart' | undefined) {
  if (isSafeMethod(req.method)) return '';
  const contentType = req.headers.get('content-type');
  if (spec === 'multipart') {
    if (!isMultipartType(contentType)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    return '';
  }
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (declared > MAX_JSON_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
  const text = await readCapped(req, MAX_JSON_BODY_BYTES);
  if (text.length > 0 && !isJsonType(contentType)) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  return text;
}

/** Reads the body stream, refusing more than `max` bytes without buffering the rest. */
async function readCapped(req: Request, max: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new AppError('PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseBody<B>(spec: z.ZodType<B> | 'multipart' | undefined, text: string): B {
  if (spec === undefined || spec === 'multipart') return undefined as B;
  let value: unknown;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('MALFORMED_JSON');
    }
  }
  return parse(spec, value); // an empty body parses as undefined: the schema decides
}

// ------------------------------------------------------------------------------ errors and logs

function errorResponse(
  err: unknown,
  req: NextRequest,
  rc: RequestContext,
  params: SegmentParams | undefined,
): Response {
  const e = mapError(err);
  const sqlstate = readSqlState(err);
  if (isDbBackstop(sqlstate)) {
    // The DB refused a write the service should have refused: the data is safe, the code has a bug.
    logger.error(
      { event: 'db.backstop', defense: 'db', sqlstate, code: e.code, err },
      'database backstop refused the request',
    );
  } else if (e.status >= 500 && e.cause !== undefined) {
    logger.error({ err: e.cause, code: e.code }, 'request failed');
  } else if (DENIAL_CODES.has(e.code)) {
    const claimId = typeof params?.claimId === 'string' ? params.claimId : undefined;
    logger.warn({ event: 'authz.denied', code: e.code, claimId }, 'request denied');
  }

  const res = Response.json(errorBody(e, rc.requestId), { status: e.status });
  // A 401 that arrived with a session cookie also clears it (04 §9.1).
  if (e.status === 401) {
    const appBaseUrl = safeAppBaseUrl();
    if (appBaseUrl && readSessionToken(req.cookies, appBaseUrl) !== undefined)
      res.headers.append('set-cookie', clearedSessionCookie(appBaseUrl));
  }
  return res;
}

const safeAppBaseUrl = (): string | undefined => {
  try {
    return env().APP_BASE_URL;
  } catch {
    return undefined;
  }
};

/** Sets headers, copying the response first if its headers are immutable (e.g. a fetch result). */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  try {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) copy.headers.set(k, v);
    return copy;
  }
}

/** One line per request (C-19 `http.request`): debug for health probes, error for 5xx. */
function logAccess(rc: RequestContext, res: Response): void {
  const durationMs = Math.round(performance.now() - rc.startedAt); // time-to-headers for streams
  const level = res.status >= 500 ? 'error' : rc.route.includes(' /api/health/') ? 'debug' : 'info';
  logger[level](
    { event: 'http.request', status: res.status, durationMs, ip: rc.ip, userAgent: rc.userAgent },
    'request completed',
  );
}
