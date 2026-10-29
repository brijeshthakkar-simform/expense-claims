import { defineRoute } from '@/server/http/define-route';
import { noContent } from '@/server/http/responses';
import * as receiptsService from '@/server/services/receipts.service';
import { ReceiptParams } from '@/shared/schemas/claims';

/**
 * DELETE /api/v1/claims/:claimId/receipts/:receiptId → 204 on my DRAFT/REJECTED claim. The stored
 * object is removed only if the claim was never submitted (D-31). 404 CLAIM_NOT_FOUND /
 * RECEIPT_NOT_FOUND; 409 CLAIM_NOT_EDITABLE / CLAIM_LOCKED.
 */
export const DELETE = defineRoute({
  auth: 'required',
  params: ReceiptParams,
  handler: async ({ serviceCtx, params }) => {
    await receiptsService.deleteReceipt(serviceCtx, params.claimId, params.receiptId);
    return noContent();
  },
});
