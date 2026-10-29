// TC-I01 (§6-3, RT-m5): every route handler is wrapped by defineRoute, only PUBLIC_ROUTES skip
// authentication, and every other route refuses each kind of non-session with 401 before it looks
// at the body. Routes are discovered from src/app/api/**/route.ts, so a new route is probed the
// moment it exists (04 §3.4). Handlers are called directly, with no proxy in the loop.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import * as meRoute from '@/app/api/v1/auth/me/route';
import { ROUTE_META } from '@/server/http/define-route';
import { PUBLIC_ROUTES } from '@/server/http/public-routes';
import { asPersona, createSession, sha256Hex, tokenOf } from '../../helpers/auth';
import { ownerSql } from '../../helpers/db';
import { makeUser } from '../../helpers/factories';
import { BASE_URL, callRoute, errorOf } from '../../helpers/http';
import {
  EXPECTED_ROUTES,
  loadRouteManifest,
  materialise,
  type Route,
} from '../../helpers/route-manifest';

const routes = await loadRouteManifest();
const isPublic = (key: string) => (PUBLIC_ROUTES as readonly string[]).includes(key);
const guarded = routes.filter((r) => !isPublic(r.key));
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A real NextRequest for the route; JSON content type by default, so the body is the only variable. */
function hit(r: Route, headers: Record<string, string> = {}, body?: string): Promise<Response> {
  const { url, params } = materialise(r.routePath);
  const req = new NextRequest(new URL(url, BASE_URL), {
    method: r.method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return r.handler(req, { params: Promise.resolve(params) });
}

/** Every guarded route answers 401 UNAUTHENTICATED to `headers` (and `body`, on unsafe methods). */
async function expectAll401(headers: Record<string, string>, body?: string) {
  // A loop over nothing would pass: the guarded set must include every expected non-public key.
  expect(guarded.map((r) => r.key)).toEqual(
    expect.arrayContaining(EXPECTED_ROUTES.filter((k) => !isPublic(k))),
  );
  for (const r of guarded) {
    const res = await hit(r, headers, UNSAFE.has(r.method) ? body : undefined);
    const { error } = await errorOf(res);
    expect([r.key, res.status, error.code]).toEqual([r.key, 401, 'UNAUTHENTICATED']);
  }
}

/** Positive control: the same cookie, when it is valid, gets past authentication. */
async function expectAuthenticated(cookie: string) {
  const res = await callRoute(meRoute, 'GET', { path: '/api/v1/auth/me', headers: { cookie } });
  expect(res.status).toBe(200);
}

describe('TC-I01 every route requires auth', () => {
  it('every exported handler for every HTTP method carries ROUTE_META', () => {
    expect(routes.map((r) => r.key)).toEqual(expect.arrayContaining(EXPECTED_ROUTES)); // never a count
    for (const r of routes) {
      expect(r.handler[ROUTE_META], `${r.key}: wrap it in defineRoute`).toBeDefined();
      expect(['required', 'public']).toContain(r.handler[ROUTE_META].auth);
    }
  });

  it('only PUBLIC_ROUTES are public', () => {
    const pub = routes.filter((r) => r.handler[ROUTE_META].auth === 'public').map((r) => r.key);
    expect(pub.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('every non-public route returns 401 UNAUTHENTICATED with no cookie', async () => {
    await expectAll401({});
  });

  it('every non-public route returns 401 UNAUTHENTICATED with a garbage cookie', async () => {
    const asha = await asPersona('asha');
    const real = tokenOf(await createSession(asha.id));
    const garbage = [
      'ec_session=not-a-token',
      `ec_session=${'A'.repeat(43)}`, // well formed, but no such session
      `ec_session=${real}x`, // one character too long
      `ec_session=${sha256Hex(real)}`, // the stored hash is not a usable cookie (DB leak case)
      `__Host-ec_session=${real}`, // right token, wrong cookie name for http
      `ec_session=${real.slice(0, 42)}%`,
    ];
    for (const cookie of garbage) await expectAll401({ cookie });
    await expectAuthenticated(`ec_session=${real}`);
  });

  it('every non-public route returns 401 UNAUTHENTICATED with an expired session', async () => {
    const asha = await asPersona('asha');
    const past = new Date(Date.now() - 1_000);
    const idleExpired = await createSession(asha.id, { idleExpiresAt: past });
    const absoluteExpired = await createSession(asha.id, { absoluteExpiresAt: past });

    await expectAll401({ cookie: idleExpired });
    await expectAll401({ cookie: absoluteExpired });
    await expectAuthenticated(await createSession(asha.id));
  });

  it('every non-public route returns 401 UNAUTHENTICATED for a deactivated user', async () => {
    const user = await makeUser();
    const cookie = await createSession(user.id);
    await expectAuthenticated(cookie);

    await ownerSql`UPDATE users SET is_active = false WHERE id = ${user.id}`;

    await expectAll401({ cookie });
  });

  it('an unauthenticated request with an invalid body gets 401, not 422', async () => {
    // Authentication runs before any parsing: an anonymous caller learns nothing about the shape.
    await expectAll401({}, JSON.stringify({ totalMinor: 1, status: 'APPROVED', claimantId: 'x' }));
    await expectAll401({}, '{"title": '); // malformed JSON: 401, not 400
    await expectAll401({ 'content-type': 'text/plain' }, 'title=x'); // wrong type: 401, not 415
    await expectAll401({}, JSON.stringify({ email: 'x'.repeat(300_000) })); // too large: 401, not 413
  });

  it('the x-middleware-subrequest header does not bypass authentication', async () => {
    // CVE-2025-29927: this internal header made Next skip middleware entirely. Authentication lives
    // inside every handler, so no header can route around it.
    for (const value of [
      'src/middleware:src/middleware:src/middleware:src/middleware:src/middleware',
      'middleware:middleware:middleware:middleware:middleware',
      'src/proxy:src/proxy:src/proxy:src/proxy:src/proxy',
      'proxy:proxy:proxy:proxy:proxy',
    ])
      await expectAll401({ 'x-middleware-subrequest': value });
  });
});
