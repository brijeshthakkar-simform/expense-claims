import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as approvalsService from '@/server/services/approvals.service';
import { ClaimIdParams, RejectInput } from '@/shared/schemas/claims';

/**
 * POST /api/v1/claims/:claimId/reject → 200 `{ data: ClaimDetail }` (REJECTED; later WAITING
 * levels CANCELLED). Gate APPROVER before any query. Body `{ revision, reason }` with a trimmed
 * reason of 10..1000 characters (422 VALIDATION_FAILED at `reason` otherwise).
 * 403 FORBIDDEN / NOT_IN_YOUR_QUEUE; 409 ALREADY_DECIDED / REVISION_MISMATCH / CONFLICT; 422.
 */
export const POST = defineRoute({
  auth: 'required',
  roles: ['APPROVER'],
  params: ClaimIdParams,
  body: RejectInput,
  handler: async ({ serviceCtx, params, body }) =>
    ok(await approvalsService.reject(serviceCtx, params.claimId, body)),
});
