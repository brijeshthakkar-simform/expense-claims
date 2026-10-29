import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as claimsService from '@/server/services/claims.service';
import { ClaimIdParams } from '@/shared/schemas/claims';

/**
 * GET /api/v1/claims/:claimId/history → 200 `{ data: ClaimHistory }`: every revision (snapshot,
 * derived outcome, chain) and every event in order. Visible exactly when the claim is (owner,
 * an approver with a PENDING/APPROVED/REJECTED step, finance); otherwise 404 CLAIM_NOT_FOUND,
 * identical to the 404 for a random id.
 */
export const GET = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  handler: async ({ serviceCtx, params }) =>
    ok(await claimsService.getClaimHistory(serviceCtx, params.claimId)),
});
