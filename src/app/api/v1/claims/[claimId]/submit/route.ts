import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as lifecycleService from '@/server/services/lifecycle.service';
import { ClaimIdParams, SubmitInput } from '@/shared/schemas/claims';

/**
 * POST /api/v1/claims/:claimId/submit → 200 `{ data: ClaimDetail }` (SUBMITTED, revision + 1, a
 * fresh chain from the total). First submit and resubmit (from REJECTED) share this route. The
 * body is optional and, if present, must be exactly `{}`.
 * 404 CLAIM_NOT_FOUND; 409 INVALID_STATUS_TRANSITION / CLAIM_LOCKED;
 * 422 NO_LINE_ITEMS / CATEGORY_INACTIVE / ROUTING_UNRESOLVABLE.
 */
export const POST = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  body: SubmitInput.optional(),
  handler: async ({ serviceCtx, params, body }) =>
    ok(await lifecycleService.submit(serviceCtx, params.claimId, body ?? {})),
});
