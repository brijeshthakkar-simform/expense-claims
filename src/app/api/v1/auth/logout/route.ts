import { clearedSessionCookie } from '@/server/auth/cookie';
import { env } from '@/server/env';
import { defineRoute } from '@/server/http/define-route';
import { noContent } from '@/server/http/responses';
import * as authService from '@/server/services/auth.service';

/**
 * POST /api/v1/auth/logout (authenticated, bodyless): deletes the session row, then clears the
 * cookie with the same attributes and Max-Age=0. 204.
 */
export const POST = defineRoute({
  auth: 'required',
  handler: async ({ serviceCtx, sessionToken }) => {
    await authService.logout(serviceCtx, sessionToken);
    const res = noContent();
    res.headers.append('set-cookie', clearedSessionCookie(env().APP_BASE_URL));
    return res;
  },
});
