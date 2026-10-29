// TC-I05 (§6-7 log join, D-40): one request id per request, echoed on the response and stamped on
// every log line by the AsyncLocalStorage mixin (06 §2.2), and DB backstops logged as page-worthy.
import { afterEach, describe, expect, inject, it } from 'vitest';
import * as catchAllRoute from '@/app/api/v1/[...path]/route';
import * as loginRoute from '@/app/api/v1/auth/login/route';
import * as logoutRoute from '@/app/api/v1/auth/logout/route';
import * as meRoute from '@/app/api/v1/auth/me/route';
import { asPersona, createSession, emailOf, tokenOf } from '../../helpers/auth';
import { backstopRoute } from '../../helpers/fault-routes';
import { callRoute, captureLogs, cookieFrom, errorOf, type LogLine } from '../../helpers/http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const me = (headers: Record<string, string>) =>
  callRoute(meRoute, 'GET', { path: '/api/v1/auth/me', headers });

let capture: ReturnType<typeof captureLogs> | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});
const linesOf = (res: Response): LogLine[] =>
  capture!.lines.filter((l) => l.requestId === res.headers.get('x-request-id'));

describe('TC-I05 request ids', () => {
  it('echoes a valid inbound x-request-id', async () => {
    const cookie = await createSession((await asPersona('asha')).id);
    for (const inbound of [
      'abcd1234', // the 8-character minimum
      'A'.repeat(64), // the 64-character maximum (claim_events.request_id is varchar(64))
      '0f6c2a1e-4b7d-4c1e-9a55-1f0c8d2e7b31',
      'trace-0f6c2a1e-4b7d',
    ]) {
      const ok = await me({ cookie, 'x-request-id': inbound });
      expect([inbound, ok.status, ok.headers.get('x-request-id')]).toEqual([inbound, 200, inbound]);

      const denied = await me({ 'x-request-id': inbound }); // and on the error envelope
      expect(denied.headers.get('x-request-id')).toBe(inbound);
      expect((await errorOf(denied)).error.requestId).toBe(inbound);
    }
  });

  it('replaces an invalid or oversized x-request-id with a UUID', async () => {
    const seen = new Set<string>();
    for (const inbound of [
      'abc1234', // 7 characters
      'A'.repeat(65), // oversized
      'has spaces in it',
      'under_score_1234',
      'semi;colon;1234',
      '../../etc/passwd',
      '{"level":"fatal"}', // a log-injection attempt
      '', // empty counts as absent
    ]) {
      const res = await me({ 'x-request-id': inbound });
      const id = res.headers.get('x-request-id')!;

      expect(id, JSON.stringify(inbound)).toMatch(UUID);
      expect(id).not.toBe(inbound);
      expect((await errorOf(res)).error.requestId).toBe(id);
      seen.add(id);
    }
    const anonymous = await me({});
    expect(anonymous.headers.get('x-request-id')).toMatch(UUID);
    seen.add(anonymous.headers.get('x-request-id')!);
    expect(seen.size).toBe(9); // a fresh id per request
  });

  it('every log line within a request carries requestId and userId', async () => {
    const asha = await asPersona('asha');
    const password = inject('demoPassword');
    capture = captureLogs();

    const loggedIn = await callRoute(loginRoute, 'POST', {
      path: '/api/v1/auth/login',
      body: { email: emailOf('asha'), password },
    });
    const cookie = cookieFrom(loggedIn);
    const requests = [
      loggedIn,
      await me({ cookie }),
      await callRoute(catchAllRoute, 'GET', {
        path: '/api/v1/nope',
        params: { path: ['nope'] },
        headers: { cookie },
      }),
      await callRoute(logoutRoute, 'POST', { path: '/api/v1/auth/logout', headers: { cookie } }),
    ];
    expect(requests.map((r) => r.status)).toEqual([200, 200, 404, 204]);

    const ids = requests.map((r) => r.headers.get('x-request-id'));
    expect(new Set(ids).size).toBe(requests.length);
    expect(capture.lines.length).toBeGreaterThan(requests.length);
    for (const line of capture.lines) {
      expect(ids, JSON.stringify(line)).toContain(line.requestId);
      expect(line.userId, JSON.stringify(line)).toBe(asha.id);
      expect(line).toMatchObject({ service: 'expense-claims', route: expect.any(String) });
    }
    // Exactly one access line per request, plus the auth events.
    for (const res of requests)
      expect(linesOf(res).filter((l) => l.event === 'http.request')).toHaveLength(1);
    expect(linesOf(requests[0]!).map((l) => l.event)).toContain('auth.login.succeeded');
    expect(linesOf(requests[3]!).map((l) => l.event)).toContain('auth.logout');
    expect(linesOf(requests[1]!)[0]).toMatchObject({ route: 'GET /api/v1/auth/me', status: 200 });

    // Never logged: the password, the session token, or the email (people are logged by userId).
    const all = JSON.stringify(capture.lines);
    for (const secret of [password, tokenOf(cookie), emailOf('asha')])
      expect(all).not.toContain(secret);
  });

  it('a DB-backstop error is logged at error with defense=db', async () => {
    const asha = await asPersona('asha');
    capture = captureLogs();

    const res = await callRoute(backstopRoute, 'POST', {
      path: '/api/v1/test/backstop',
      as: 'asha',
    });

    expect(res.status).toBe(500);
    expect((await errorOf(res)).error.code).toBe('INTERNAL_ERROR');
    const lines = linesOf(res);
    const backstops = capture.lines.filter((l) => l.event === 'db.backstop');
    expect(backstops).toHaveLength(1);
    expect(backstops[0]).toMatchObject({
      level: 'error',
      event: 'db.backstop',
      defense: 'db',
      sqlstate: 'UC012',
      code: 'INTERNAL_ERROR',
      requestId: res.headers.get('x-request-id'),
      userId: asha.id,
    });
    expect(lines.find((l) => l.event === 'http.request')).toMatchObject({
      level: 'error', // 5xx access lines are errors too
      status: 500,
    });
  });
});
