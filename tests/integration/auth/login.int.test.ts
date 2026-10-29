// TC-I02 (§6-3, RT-M12): opaque DB sessions (04 §2.2–§2.5). The only test that logs in through the
// real login route with a password; the password is generated per run by global-setup.ts.
import { describe, expect, inject, it, vi } from 'vitest';
import * as loginRoute from '@/app/api/v1/auth/login/route';
import * as logoutRoute from '@/app/api/v1/auth/logout/route';
import * as meRoute from '@/app/api/v1/auth/me/route';
import { asPersona, createSession, emailOf, sha256Hex, tokenOf } from '../../helpers/auth';
import { ownerSql } from '../../helpers/db';
import { makeUser } from '../../helpers/factories';
import { callRoute, cookieFrom, errorOf, setCookies, type RouteModule } from '../../helpers/http';

const demoPassword = inject('demoPassword');
const TOKEN = '[A-Za-z0-9_-]{43}';
const MINUTE = 60_000;

const login = (
  body: { email: string; password: string },
  headers: Record<string, string> = {},
  route: RouteModule = loginRoute,
) => callRoute(route, 'POST', { path: '/api/v1/auth/login', body, headers });

const me = (cookie: string, route: RouteModule = meRoute) =>
  callRoute(route, 'GET', { path: '/api/v1/auth/me', headers: { cookie } });

const logout = (cookie: string) =>
  callRoute(logoutRoute, 'POST', { path: '/api/v1/auth/logout', headers: { cookie } });

const sessionRow = async (cookie: string) =>
  (
    await ownerSql<{
      user_id: string;
      idle_expires_at: Date;
      absolute_expires_at: Date;
      last_seen_at: Date;
      user_agent: string | null;
    }>`
      SELECT user_id, idle_expires_at, absolute_expires_at, last_seen_at, user_agent
        FROM sessions WHERE token_hash = ${sha256Hex(tokenOf(cookie))}`
  )[0];

const expect401 = async (res: Response) => {
  expect(res.status).toBe(401);
  expect((await errorOf(res)).error.code).toBe('UNAUTHENTICATED');
};

describe('TC-I02 login and sessions', () => {
  it('login sets an HttpOnly SameSite=Lax session cookie (Secure and __Host- prefix on https)', async () => {
    const asha = await asPersona('asha');
    const res = await login(
      { email: emailOf('asha'), password: demoPassword },
      { 'user-agent': 'tc-i02/1.0' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        user: {
          id: asha.id,
          email: 'asha.rao@acme.test',
          name: 'Asha Rao',
          role: 'EMPLOYEE',
          canApprove: false,
          isFinance: false,
        },
      },
    });
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    // http (APP_BASE_URL=http://localhost:3000): plain name, no Secure, no Domain.
    expect(cookies[0]).toMatch(
      new RegExp(`^ec_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200$`),
    );

    // Only sha256(token) is stored, with the idle (60 min) and absolute (12 h) expiries.
    const cookie = cookieFrom(res);
    const row = await sessionRow(cookie);
    expect(row).toMatchObject({ user_id: asha.id, user_agent: 'tc-i02/1.0' });
    expect(row!.idle_expires_at.getTime() - Date.now()).toBeGreaterThan(59 * MINUTE);
    expect(row!.idle_expires_at.getTime() - Date.now()).toBeLessThanOrEqual(60 * MINUTE);
    expect(row!.absolute_expires_at.getTime() - Date.now()).toBeGreaterThan(719 * MINUTE);
    expect(await ownerSql`SELECT 1 FROM sessions WHERE token_hash = ${tokenOf(cookie)}`).toEqual(
      [],
    );
    expect((await me(cookie)).status).toBe(200);

    // https: the same routes on a fresh module graph that sees an https APP_BASE_URL.
    vi.stubEnv('APP_BASE_URL', 'https://claims.acme.test');
    vi.resetModules();
    try {
      const httpsLogin = (await import('@/app/api/v1/auth/login/route')) as RouteModule;
      const httpsMe = (await import('@/app/api/v1/auth/me/route')) as RouteModule;
      const secure = await login(
        { email: emailOf('asha'), password: demoPassword },
        {},
        httpsLogin,
      );

      expect(secure.status).toBe(200);
      expect(setCookies(secure)).toEqual([
        expect.stringMatching(
          new RegExp(
            `^__Host-ec_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$`,
          ),
        ),
      ]);
      const hostCookie = cookieFrom(secure);
      expect((await me(hostCookie, httpsMe)).status).toBe(200);
      // On https only the __Host- name is read: the same token under the plain name is no session.
      await expect401(await me(`ec_session=${tokenOf(hostCookie)}`, httpsMe));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('wrong password and unknown email return identical 401 INVALID_CREDENTIALS', async () => {
    const noPassword = await makeUser(); // password_hash IS NULL
    const inactive = await makeUser();
    await ownerSql`
      UPDATE users SET is_active = false,
             password_hash = (SELECT password_hash FROM users WHERE email = ${emailOf('asha')})
       WHERE id = ${inactive.id}`; // the right password, but deactivated

    const attempts = [
      { email: emailOf('asha'), password: `${demoPassword}x` }, // wrong password
      { email: 'nobody@acme.test', password: demoPassword }, // unknown email
      { email: noPassword.email, password: demoPassword },
      { email: inactive.email, password: demoPassword },
    ];
    for (const body of attempts) {
      const res = await login(body);
      const { error } = await errorOf(res);
      const { requestId, ...rest } = error;

      expect([body.email, res.status]).toEqual([body.email, 401]);
      expect(rest).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
      expect(requestId).toBe(res.headers.get('x-request-id'));
      expect(setCookies(res)).toEqual([]);
    }
    expect(await ownerSql`SELECT id FROM sessions`).toEqual([]);
  });

  it('logout deletes the session and the old cookie gets 401', async () => {
    const asha = await asPersona('asha');
    const cookie = await createSession(asha.id);
    const otherDevice = await createSession(asha.id);
    expect((await me(cookie)).status).toBe(200);

    const res = await logout(cookie);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(setCookies(res)).toEqual(['ec_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
    expect(await sessionRow(cookie)).toBeUndefined();

    const after = await me(cookie);
    expect(setCookies(after)).toEqual(['ec_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
    await expect401(after);
    await expect401(await logout(cookie));
    expect((await me(otherDevice)).status).toBe(200); // only the presented session is revoked
  });

  it('idle and absolute expiry are enforced', async () => {
    const asha = await asPersona('asha');
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms);

    await expect401(await me(await createSession(asha.id, { idleExpiresAt: at(-1_000) })));
    await expect401(await me(await createSession(asha.id, { absoluteExpiresAt: at(-1_000) })));

    // Idle expiry slides, written at most every 5 minutes and never past the absolute expiry.
    const recent = await createSession(asha.id, {
      lastSeenAt: at(-1 * MINUTE),
      idleExpiresAt: at(MINUTE),
    });
    const stale = await createSession(asha.id, {
      lastSeenAt: at(-6 * MINUTE),
      idleExpiresAt: at(MINUTE),
    });
    const capped = await createSession(asha.id, {
      lastSeenAt: at(-6 * MINUTE),
      idleExpiresAt: at(MINUTE),
      absoluteExpiresAt: at(30 * MINUTE),
    });
    for (const cookie of [recent, stale, capped]) expect((await me(cookie)).status).toBe(200);

    expect((await sessionRow(recent))!.idle_expires_at).toEqual(at(MINUTE)); // no write
    expect((await sessionRow(stale))!.idle_expires_at.getTime()).toBeGreaterThan(now + 59 * MINUTE);
    expect((await sessionRow(capped))!.idle_expires_at).toEqual(at(30 * MINUTE));
  });

  it('deactivating a user revokes their sessions on the next request', async () => {
    const user = await makeUser();
    const cookie = await createSession(user.id);
    expect((await me(cookie)).status).toBe(200);

    await ownerSql`UPDATE users SET is_active = false WHERE id = ${user.id}`;

    await expect401(await me(cookie));
  });

  it('a role change takes effect on the next request', async () => {
    const user = await makeUser({ canApprove: true });
    const cookie = await createSession(user.id);
    expect(await (await me(cookie)).json()).toMatchObject({
      data: { id: user.id, role: 'EMPLOYEE', canApprove: true, isFinance: false },
    });

    // users_finance_cannot_approve: demoting to FINANCE also drops can_approve.
    await ownerSql`UPDATE users SET role = 'FINANCE', can_approve = false WHERE id = ${user.id}`;

    expect(await (await me(cookie)).json()).toMatchObject({
      data: { id: user.id, role: 'FINANCE', canApprove: false, isFinance: true },
    });
  });

  it('login issues a new token and deletes any presented session', async () => {
    const asha = await asPersona('asha');
    const presented = await createSession(asha.id);

    const res = await login(
      { email: emailOf('asha'), password: demoPassword },
      { cookie: presented },
    );

    expect(res.status).toBe(200);
    const fresh = cookieFrom(res);
    expect(tokenOf(fresh)).not.toBe(tokenOf(presented));
    expect(await sessionRow(presented)).toBeUndefined(); // fixation-safe
    await expect401(await me(presented));
    expect((await me(fresh)).status).toBe(200);

    const again = cookieFrom(await login({ email: emailOf('asha'), password: demoPassword }));
    expect(tokenOf(again)).not.toBe(tokenOf(fresh)); // a new token on every login
  });
});
