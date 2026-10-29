// Calling route handlers in-process (07 §4, D-43). Real: defineRoute (request id, auth from
// req.cookies, CSRF, role gate, Zod, error mapping, access log), services, repositories, Prisma,
// triggers and grants. Not real: the Next server, proxy.ts, cookies over a socket. No Origin header
// is sent unless a test sets one.
import { NextRequest } from 'next/server';
import pino from 'pino';
import { logger } from '@/server/logging/logger';
import { asPersona, createSession, type Persona } from './auth';

export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string | string[]>> },
) => Promise<Response>;
export type RouteModule = Partial<Record<Method, Handler>>;

export const BASE_URL = 'http://localhost:3000'; // APP_BASE_URL in integration-setup.ts

export async function callRoute(
  mod: RouteModule,
  method: Method,
  o: {
    path: string;
    params?: Record<string, string | string[]>;
    query?: Record<string, string>;
    /** JSON-encoded unless it is a string (malformed-JSON cases) or FormData (uploads). */
    body?: unknown;
    /** A persona or user id: a fresh session is minted and sent as the cookie. */
    as?: Persona | { id: string };
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const handler = mod[method];
  if (!handler) throw new Error(`route module does not export ${method}`);
  const url = new URL(o.path, BASE_URL);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers = new Headers(o.headers);
  if (o.as) {
    const userId = typeof o.as === 'string' ? (await asPersona(o.as)).id : o.as.id;
    headers.append('cookie', await createSession(userId));
  }
  let body: BodyInit | undefined;
  if (o.body instanceof FormData || typeof o.body === 'string') body = o.body;
  else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return handler(new NextRequest(url, { method, headers, body }), {
    params: Promise.resolve(o.params ?? {}),
  });
}

/** The C-08 error envelope, typed for assertions. */
export interface ErrorJson {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}
export const errorOf = async (res: Response): Promise<ErrorJson> => (await res.json()) as ErrorJson;

/** All Set-Cookie values on a response. */
export const setCookies = (res: Response): string[] => res.headers.getSetCookie();

/** `name=value` of the first Set-Cookie, ready to send back as a Cookie header. */
export function cookieFrom(res: Response): string {
  const first = setCookies(res)[0];
  if (!first) throw new Error('response has no Set-Cookie');
  return first.split(';')[0]!;
}

export type LogLine = Record<string, unknown> & { level: string; msg?: string; event?: string };

/**
 * Captures the app logger's output as parsed JSON lines (TC-I05). Swaps the pino destination
 * stream and raises the level from 'silent' to 'info' until `stop()` is called.
 */
export function captureLogs(level: pino.Level = 'info'): { lines: LogLine[]; stop(): void } {
  const target = logger as unknown as Record<symbol, unknown>;
  const { streamSym } = pino.symbols;
  const previousStream = target[streamSym];
  const previousLevel = logger.level;
  const lines: LogLine[] = [];
  target[streamSym] = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) if (line) lines.push(JSON.parse(line) as LogLine);
    },
  };
  logger.level = level;
  return {
    lines,
    stop() {
      target[streamSym] = previousStream;
      logger.level = previousLevel;
    },
  };
}
