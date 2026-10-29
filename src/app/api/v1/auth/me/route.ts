import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as authService from '@/server/services/auth.service';

/** GET /api/v1/auth/me → 200 `{ data: MeDto }`, read from the live users row on every request. */
export const GET = defineRoute({
  auth: 'required',
  handler: ({ serviceCtx }) => ok(authService.me(serviceCtx)),
});
