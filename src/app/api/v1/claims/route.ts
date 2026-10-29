import { defineRoute } from '@/server/http/define-route';
import { created, okPage } from '@/server/http/responses';
import * as claimsService from '@/server/services/claims.service';
import { CreateClaimInput } from '@/shared/schemas/claims';
import { ClaimListQuery } from '@/shared/schemas/queries';

/**
 * GET /api/v1/claims → 200 `{ data: ClaimSummary[], page }`: the caller's own claims only
 * (`claimant_id = me`), newest first, keyset-paginated. 422 INVALID_CURSOR / VALIDATION_FAILED.
 */
export const GET = defineRoute({
  auth: 'required',
  query: ClaimListQuery,
  handler: async ({ serviceCtx, query }) =>
    okPage(await claimsService.listMyClaims(serviceCtx, query)),
});

/**
 * POST /api/v1/claims → 201 `{ data: ClaimDetail }`: a new DRAFT owned by the caller. A total-like
 * key is 422 TOTAL_IS_DERIVED, another server-owned key 422 READ_ONLY_FIELD.
 */
export const POST = defineRoute({
  auth: 'required',
  body: CreateClaimInput,
  handler: async ({ serviceCtx, body }) =>
    created(await claimsService.createClaim(serviceCtx, body)),
});
