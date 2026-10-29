import { sessionCookie } from '@/server/auth/cookie';
import { env } from '@/server/env';
import { callMeta } from '@/server/http/call-meta';
import { defineRoute } from '@/server/http/define-route';
import { bindUserToRequest } from '@/server/http/request-context';
import { ok } from '@/server/http/responses';
import * as authService from '@/server/services/auth.service';
import { LoginInput } from '@/shared/schemas/auth';

/**
 * POST /api/v1/auth/login (public; CSRF is still checked, which prevents login CSRF).
 * 200 `{data:{user: MeDto}}` + Set-Cookie, or the same 401 INVALID_CREDENTIALS for every failure.
 */
export const POST = defineRoute({
  auth: 'public',
  body: LoginInput,
  handler: async ({ req, body, sessionToken }) => {
    const { token, user } = await authService.login(body, {
      userAgent: callMeta(req).userAgent,
      presentedToken: sessionToken,
    });
    bindUserToRequest(user.id);
    const e = env();
    const res = ok({ user });
    // Max-Age = the absolute lifetime (12 h → 43200); server-side idle expiry is the real control.
    const maxAge = e.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600;
    res.headers.append('set-cookie', sessionCookie(token, e.APP_BASE_URL, maxAge));
    return res;
  },
});
