import { AppError } from '@/server/errors/app-error';
import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import { readiness } from '@/server/services/health.service';

/**
 * Public probe (PUBLIC_ROUTES). 200 `{data:{status:'ready', checks}}`, or 503 NOT_READY with the
 * generic error envelope; the failing checks go to the log, never to the response.
 */
export const GET = defineRoute({
  auth: 'public',
  handler: async () => {
    const { ready, checks } = await readiness();
    if (!ready) throw new AppError('NOT_READY');
    return ok({ status: 'ready', checks });
  },
});
