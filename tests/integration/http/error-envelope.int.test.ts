// TC-I04 (§5, §6-2): one error envelope for every non-2xx response, joined to the logs by its
// requestId, with generic 5xx bodies (04 §9.1).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as catchAllRoute from '@/app/api/v1/[...path]/route';
import * as readyRoute from '@/app/api/health/ready/route';
import * as loginRoute from '@/app/api/v1/auth/login/route';
import * as logoutRoute from '@/app/api/v1/auth/logout/route';
import * as meRoute from '@/app/api/v1/auth/me/route';
import { ERROR_CATALOGUE } from '@/server/errors/codes';
import { ERROR_CODES } from '@/shared/errors';
import { ownerClient } from '../../helpers/db';
import {
  backstopRoute,
  crashRoute,
  SECRET_HOST,
  SECRET_SQL,
  unavailableRoute,
} from '../../helpers/fault-routes';
import { callRoute, type Method } from '../../helpers/http';
import { METHODS } from '../../helpers/route-manifest';

/** C-08, strictly: exactly these keys, details optional and only on 4xx. */
const Envelope = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().min(8),
  }),
});

const LOGIN = '/api/v1/auth/login';
const login = (body: unknown, headers: Record<string, string> = {}) =>
  callRoute(loginRoute, 'POST', { path: LOGIN, body, headers });

/** One request per failure class the P1 routes can produce. */
const failures: [string, () => Promise<Response>][] = [
  ['400 MALFORMED_JSON', () => login('{"email": ', { 'content-type': 'application/json' })],
  ['401 UNAUTHENTICATED', () => callRoute(meRoute, 'GET', { path: '/api/v1/auth/me' })],
  ['401 INVALID_CREDENTIALS', () => login({ email: 'nobody@acme.test', password: 'wrong-pass' })],
  [
    '403 CSRF_REJECTED',
    () =>
      callRoute(logoutRoute, 'POST', {
        path: '/api/v1/auth/logout',
        as: 'asha',
        headers: { origin: 'https://evil.example' },
      }),
  ],
  [
    '404 ROUTE_NOT_FOUND',
    () =>
      callRoute(catchAllRoute, 'GET', {
        path: '/api/v1/nope',
        params: { path: ['nope'] },
        as: 'asha',
      }),
  ],
  ['413 PAYLOAD_TOO_LARGE', () => login({ email: 'a@acme.test', password: 'x'.repeat(300_000) })],
  ['415 UNSUPPORTED_MEDIA_TYPE', () => login('{}', { 'content-type': 'text/plain' })],
  ['422 VALIDATION_FAILED', () => login({ email: 'not-an-email', password: '' })],
  ['422 TOTAL_IS_DERIVED', () => login({ email: 'a@acme.test', password: 'x', totalMinor: 1 })],
  ['422 READ_ONLY_FIELD', () => login({ email: 'a@acme.test', password: 'x', status: 'APPROVED' })],
  ['500 INTERNAL_ERROR', () => callRoute(crashRoute, 'GET', { path: '/api/v1/test/crash' })],
  [
    '500 INTERNAL_ERROR (DB backstop)',
    () => callRoute(backstopRoute, 'POST', { path: '/api/v1/test/backstop', as: 'asha' }),
  ],
  [
    '503 SERVICE_UNAVAILABLE',
    () => callRoute(unavailableRoute, 'GET', { path: '/api/v1/test/down' }),
  ],
  ['503 NOT_READY', notReady],
];

/** /api/health/ready with an integrity trigger disabled by the owner, re-enabled afterwards. */
async function notReady(): Promise<Response> {
  const owner = await ownerClient();
  const trigger = 'line_items_20_recompute_after_insert';
  await owner.query(`ALTER TABLE line_items DISABLE TRIGGER ${trigger}`);
  try {
    return await callRoute(readyRoute, 'GET', { path: '/api/health/ready' });
  } finally {
    await owner.query(`ALTER TABLE line_items ENABLE TRIGGER ${trigger}`);
  }
}

describe('TC-I04 error envelope', () => {
  it('every non-2xx response has {error:{code,message,requestId}}', async () => {
    for (const [label, call] of failures) {
      const res = await call();
      const body: unknown = await res.json();
      const parsed = Envelope.safeParse(body);

      expect(parsed.success, `${label}: ${JSON.stringify(body)}`).toBe(true);
      const { code } = parsed.data!.error;
      expect(`${res.status} ${code}`, label).toBe(label.split(' (')[0]);
      expect(ERROR_CATALOGUE[code].status, label).toBe(res.status);
      expect(res.headers.get('content-type'), label).toMatch(/^application\/json/);
      expect(res.headers.get('cache-control'), label).toBe('no-store');
    }
  });

  it('envelope requestId equals the x-request-id header', async () => {
    for (const [label, call] of failures) {
      const res = await call();
      const { error } = (await res.json()) as z.infer<typeof Envelope>;
      expect(error.requestId, label).toBe(res.headers.get('x-request-id'));
    }

    // An accepted inbound id is the id in both places, so the client can quote it.
    const inbound = 'trace-0f6c2a1e-4b7d';
    const res = await callRoute(meRoute, 'GET', {
      path: '/api/v1/auth/me',
      headers: { 'x-request-id': inbound },
    });
    expect(res.headers.get('x-request-id')).toBe(inbound);
    expect(((await res.json()) as z.infer<typeof Envelope>).error.requestId).toBe(inbound);
  });

  it('5xx responses contain no stack, SQL or details', async () => {
    const fiveHundreds = failures.filter(([label]) => label.startsWith('5'));
    expect(fiveHundreds.length).toBeGreaterThanOrEqual(4);
    for (const [label, call] of fiveHundreds) {
      const res = await call();
      const text = await res.text();
      const { error } = JSON.parse(text) as z.infer<typeof Envelope>;

      // Exactly the catalogue's generic message plus the reference; no details key at all.
      expect(error, label).toEqual({
        code: error.code,
        message: `${ERROR_CATALOGUE[error.code].message} Quote reference ${error.requestId}.`,
        requestId: error.requestId,
      });
      for (const leak of [
        SECRET_SQL,
        SECRET_HOST,
        'password_hash',
        'SELECT',
        'TypeError',
        '    at ',
        '.ts:',
        'UC012',
        'CHAIN_INVALID',
        'line_items',
        'trigger',
        'stack',
      ])
        expect(text, `${label} leaks ${leak}`).not.toContain(leak);
    }
  });

  it('unknown /api/v1 paths return 404 ROUTE_NOT_FOUND', async () => {
    const paths = [
      ['nope'],
      ['claims', '0199f3a0-0000-7000-8000-000000000000', 'frobnicate'],
      ['v2'],
    ];
    for (const method of METHODS as readonly Method[])
      for (const path of paths) {
        const res = await callRoute(catchAllRoute, method, {
          path: `/api/v1/${path.join('/')}`,
          params: { path },
          as: 'asha',
        });
        const body = Envelope.parse(await res.json());
        expect([method, path, res.status, body.error.code]).toEqual([
          method,
          path,
          404,
          'ROUTE_NOT_FOUND',
        ]);
        expect(body.error.message).toBe('No such API route.');
      }
  });
});
