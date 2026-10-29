import { defineRoute } from '@/server/http/define-route';
import { okPage } from '@/server/http/responses';
import * as approvalsService from '@/server/services/approvals.service';
import { ApprovalQueueQuery } from '@/shared/schemas/queries';

/**
 * GET /api/v1/approvals → 200 `{ data: ApprovalTask[], page }`: my steps only (`approver_id = me`).
 * `status=PENDING` (default) lists what waits for me, oldest first; `status=APPROVED,REJECTED` (or
 * one of them) what I decided, newest first. `from`/`to` (IST days) filter activated_at or
 * decided_at respectively. Gate APPROVER: 403 FORBIDDEN for finance and non-approvers.
 * 422 INVALID_CURSOR / VALIDATION_FAILED.
 */
export const GET = defineRoute({
  auth: 'required',
  roles: ['APPROVER'],
  query: ApprovalQueueQuery,
  handler: async ({ serviceCtx, query }) =>
    okPage(await approvalsService.listQueue(serviceCtx, query)),
});
