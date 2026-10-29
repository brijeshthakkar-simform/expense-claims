import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as lifecycleService from '@/server/services/lifecycle.service';
import { ClaimIdParams, RecallInput } from '@/shared/schemas/claims';

/**
 * POST /api/v1/claims/:claimId/recall → 200 `{ data: ClaimDetail }` (DRAFT; the open steps
 * CANCELLED, approved ones kept in history). Owner only, while SUBMITTED, i.e. until the final
 * approval. The body is optional: `{ note?: string ≤ 500 }`.
 * 404 CLAIM_NOT_FOUND (not mine, incl. finance and approvers); 409 INVALID_STATUS_TRANSITION /
 * CLAIM_LOCKED; 422 VALIDATION_FAILED.
 */
export const POST = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  body: RecallInput.optional(),
  handler: async ({ serviceCtx, params, body }) =>
    ok(await lifecycleService.recall(serviceCtx, params.claimId, body ?? {})),
});
