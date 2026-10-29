import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import { liveness } from '@/server/services/health.service';

/** Public probe (PUBLIC_ROUTES): 200 whenever the process answers; never touches the DB (D-41). */
export const GET = defineRoute({
  auth: 'public',
  handler: () => ok(liveness()),
});
