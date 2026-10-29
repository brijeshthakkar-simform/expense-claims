// TC-I03 (D-06, RT-m3): CSRF is SameSite=Lax plus an Origin / Sec-Fetch-Site check on unsafe
// methods, plus JSON-only bodies (04 §2.6). The one GET with weight, the finance export, also refuses
// Sec-Fetch-Site: cross-site (RT-m3): SameSite=Lax cookies ride on top-level cross-site GETs.
import { describe, expect, inject, it } from 'vitest';
import * as catchAllRoute from '@/app/api/v1/[...path]/route';
import * as loginRoute from '@/app/api/v1/auth/login/route';
import * as logoutRoute from '@/app/api/v1/auth/logout/route';
import * as meRoute from '@/app/api/v1/auth/me/route';
import * as financeClaimsRoute from '@/app/api/v1/finance/claims/route';
import * as exportRoute from '@/app/api/v1/finance/exports/approved-claims/route';
import { asPersona, createSession, emailOf } from '../../helpers/auth';
import { ownerSql } from '../../helpers/db';
import { callRoute, errorOf, setCookies } from '../../helpers/http';

const credentials = () => ({ email: emailOf('asha'), password: inject('demoPassword') });
const ashaCookie = async () => createSession((await asPersona('asha')).id);

const logout = (headers: Record<string, string>, body?: unknown) =>
  callRoute(logoutRoute, 'POST', { path: '/api/v1/auth/logout', headers, body });
const login = (headers: Record<string, string>, body: unknown = credentials()) =>
  callRoute(loginRoute, 'POST', { path: '/api/v1/auth/login', headers, body });
const meStatus = async (cookie: string) =>
  (await callRoute(meRoute, 'GET', { path: '/api/v1/auth/me', headers: { cookie } })).status;

const expectCode = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect((await errorOf(res)).error.code).toBe(code);
};

describe('TC-I03 CSRF', () => {
  it('POST with a cross-site Origin returns 403 CSRF_REJECTED', async () => {
    const cookie = await ashaCookie();
    const crossSite: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'http://localhost:3000.evil.example' },
      { origin: 'http://localhost:3001' }, // a different port is a different origin
      { origin: 'null' }, // sandboxed iframes and some redirects
      { 'sec-fetch-site': 'cross-site' }, // no Origin, but the browser says cross-site
      { 'sec-fetch-site': 'same-site' }, // a sibling subdomain is not same-origin
    ];
    for (const headers of crossSite) {
      await expectCode(await logout({ cookie, ...headers }), 403, 'CSRF_REJECTED');
    }
    expect(await meStatus(cookie)).toBe(200); // the session survived every attempt

    // Login CSRF: a cross-site form can't sign the victim into the attacker's account.
    const forged = await login({ origin: 'https://evil.example' });
    await expectCode(forged, 403, 'CSRF_REJECTED');
    expect(setCookies(forged)).toEqual([]);
    expect(await ownerSql`SELECT id FROM sessions`).toHaveLength(1); // only Asha's own

    // Pipeline order: authentication first (401), then CSRF (403), then routing (404).
    const unknownPath = { path: '/api/v1/claims', params: { path: ['claims'] } };
    const evil = { origin: 'https://evil.example' };
    await expectCode(
      await callRoute(catchAllRoute, 'POST', { ...unknownPath, headers: evil }),
      401,
      'UNAUTHENTICATED',
    );
    await expectCode(
      await callRoute(catchAllRoute, 'POST', { ...unknownPath, headers: { ...evil, cookie } }),
      403,
      'CSRF_REJECTED',
    );
  });

  it('requests without an Origin header are allowed', async () => {
    // curl and server-to-server callers send no Origin, and carry no ambient browser cookie.
    const res = await login({});
    expect(res.status).toBe(200);
    expect(setCookies(res)).toHaveLength(1);

    const allowed: Record<string, string>[] = [
      {}, // no Origin, no Sec-Fetch-Site
      { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }, // our own UI
      { 'sec-fetch-site': 'none' }, // typed into the address bar
    ];
    for (const headers of allowed) {
      const cookie = await ashaCookie();
      const out = await logout({ cookie, ...headers });
      expect([headers, out.status]).toEqual([headers, 204]);
    }

    // Safe methods are not Origin-checked (only the export GET is, from P7).
    const cookie = await ashaCookie();
    const read = await callRoute(meRoute, 'GET', {
      path: '/api/v1/auth/me',
      headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(read.status).toBe(200);
  });

  it('JSON routes reject non-JSON content types with 415', async () => {
    const json = JSON.stringify(credentials());
    const form = new FormData();
    form.set('email', credentials().email);
    form.set('password', credentials().password);
    const refused: [Record<string, string>, BodyInit][] = [
      [{ 'content-type': 'text/plain' }, json], // a cross-site form can send text/plain
      [{ 'content-type': 'application/x-www-form-urlencoded' }, 'email=a%40acme.test&password=x'],
      [{}, form], // multipart/form-data with a boundary
      [{ 'content-type': 'application/jsonp' }, json],
    ];
    for (const [headers, body] of refused) {
      const res = await callRoute(loginRoute, 'POST', {
        path: '/api/v1/auth/login',
        headers,
        body,
      });
      await expectCode(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
      expect(setCookies(res)).toEqual([]);
    }

    // Parameters on the JSON type are fine.
    const ok = await login({ 'content-type': 'application/json; charset=utf-8' }, json);
    expect(ok.status).toBe(200);

    // A bodyless route still refuses a non-JSON body, and does nothing.
    const cookie = await ashaCookie();
    const res = await logout({ cookie, 'content-type': 'text/plain' }, 'logout');
    await expectCode(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
    expect(await meStatus(cookie)).toBe(200);
  });

  it('export GET with Sec-Fetch-Site: cross-site returns 403 CSRF_REJECTED', async () => {
    const farah = await createSession((await asPersona('farah')).id);
    const exportGet = (headers: Record<string, string>) =>
      callRoute(exportRoute, 'GET', {
        path: '/api/v1/finance/exports/approved-claims',
        query: { from: '2026-09-01', to: '2026-09-30' },
        headers,
      });

    // A cross-site page can't make the browser start a 366-day download with farah's cookie
    const refused: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    ];
    for (const extra of refused) {
      const res = await exportGet({ cookie: farah, ...extra });
      expect(res.headers.get('content-disposition')).toBeNull(); // no CSV, not even a header row
      await expectCode(res, 403, 'CSRF_REJECTED');
    }

    // The finance page's same-origin <a download>, a typed URL, a same-site link and curl all work
    const allowed: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-site': 'same-site' },
      {},
    ];
    for (const extra of allowed) {
      const res = await exportGet({ cookie: farah, ...extra });
      expect([extra, res.status]).toEqual([extra, 200]);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(await res.text()).toMatch(/^claim_number,claim_id,/); // the empty period's header row
    }

    // Pipeline order: authentication (401), then CSRF (403 CSRF_REJECTED), then the role gate
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    await expectCode(await exportGet(crossSite), 401, 'UNAUTHENTICATED');
    await expectCode(
      await exportGet({ ...crossSite, cookie: await ashaCookie() }),
      403,
      'CSRF_REJECTED',
    );
    await expectCode(await exportGet({ cookie: await ashaCookie() }), 403, 'FORBIDDEN');

    // Only the export is on the list: the finance list GET is an ordinary safe read
    const list = await callRoute(financeClaimsRoute, 'GET', {
      path: '/api/v1/finance/claims',
      headers: { cookie: farah, ...crossSite },
    });
    expect(list.status).toBe(200);
  });
});
