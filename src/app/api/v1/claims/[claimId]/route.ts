import { defineRoute } from '@/server/http/define-route';
import { noContent, ok } from '@/server/http/responses';
import * as claimsService from '@/server/services/claims.service';
import { ClaimIdParams, ReplaceClaimInput } from '@/shared/schemas/claims';

// A malformed claimId is 404 CLAIM_NOT_FOUND (defineRoute, 04 §6.1), byte-identical to the 404
// for a claim that exists but isn't visible or isn't yours.

/** GET → 200 `{ data: ClaimDetail }` if visible (owner or FINANCE in P2), else 404 CLAIM_NOT_FOUND. */
export const GET = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  handler: async ({ serviceCtx, params }) =>
    ok(await claimsService.getClaim(serviceCtx, params.claimId)),
});

/**
 * PUT → 200 `{ data: ClaimDetail }`: replace title + line set on my DRAFT/REJECTED claim.
 * 404 CLAIM_NOT_FOUND / LINE_ITEM_NOT_FOUND; 409 CLAIM_NOT_EDITABLE / CLAIM_LOCKED;
 * 422 TOTAL_IS_DERIVED / READ_ONLY_FIELD / CATEGORY_INACTIVE / VALIDATION_FAILED.
 */
export const PUT = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  body: ReplaceClaimInput,
  handler: async ({ serviceCtx, params, body }) =>
    ok(await claimsService.replaceClaim(serviceCtx, params.claimId, body)),
});

/** DELETE → 204 for my never-submitted draft; 409 CLAIM_HAS_HISTORY / CLAIM_LOCKED; 404. */
export const DELETE = defineRoute({
  auth: 'required',
  params: ClaimIdParams,
  handler: async ({ serviceCtx, params }) => {
    await claimsService.deleteDraft(serviceCtx, params.claimId);
    return noContent();
  },
});
