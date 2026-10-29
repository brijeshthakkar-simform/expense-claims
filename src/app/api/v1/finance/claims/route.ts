import { defineRoute } from '@/server/http/define-route';
import { okPage } from '@/server/http/responses';
import * as financeService from '@/server/services/finance.service';
import { FinanceClaimsQuery } from '@/shared/schemas/queries';

/**
 * GET /api/v1/finance/claims → 200 `{ data: FinanceClaimSummary[], page }`: every employee's
 * claims, read-only, with the claimant. `status` (CSV; default SUBMITTED,APPROVED,REJECTED, DRAFT
 * only when listed), `dateField` (submittedAt | approvedAt: the sort and the column `from`/`to`
 * filter), keyset `cursor`/`limit`. Gate FINANCE: 403 FORBIDDEN for everyone else.
 * 422 INVALID_CURSOR / VALIDATION_FAILED.
 */
export const GET = defineRoute({
  auth: 'required',
  roles: ['FINANCE'],
  query: FinanceClaimsQuery,
  handler: async ({ serviceCtx, query }) =>
    okPage(await financeService.listFinanceClaims(serviceCtx, query)),
});
