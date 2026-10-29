import { defineRoute } from '@/server/http/define-route';
import { ok } from '@/server/http/responses';
import * as approvalsService from '@/server/services/approvals.service';
import { ApproveInput, ClaimIdParams } from '@/shared/schemas/claims';

/**
 * POST /api/v1/claims/:claimId/approve → 200 `{ data: ClaimDetail }`. Gate APPROVER (canApprove
 * and not FINANCE) before any query; then only my PENDING step on the current revision can be
 * decided. A non-final level activates the next one (claim stays SUBMITTED); the final level
 * approves the claim. Body `{ revision, comment? }`.
 * 403 FORBIDDEN / NOT_IN_YOUR_QUEUE; 409 ALREADY_DECIDED / REVISION_MISMATCH / CONFLICT; 422.
 */
export const POST = defineRoute({
  auth: 'required',
  roles: ['APPROVER'],
  params: ClaimIdParams,
  body: ApproveInput,
  handler: async ({ serviceCtx, params, body }) =>
    ok(await approvalsService.approve(serviceCtx, params.claimId, body)),
});
