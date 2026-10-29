import { defineRoute } from '@/server/http/define-route';
import { fileAttachment } from '@/server/http/responses';
import * as receiptsService from '@/server/services/receipts.service';
import { ReceiptParams } from '@/shared/schemas/claims';

/**
 * GET /api/v1/claims/:claimId/receipts/:receiptId/content → 200 file stream (stored Content-Type,
 * `Content-Disposition: attachment`, `nosniff`, `no-store`) for anyone who can see the claim
 * (owner, a deciding/decided approver, finance), including receipts that only an earlier
 * revision's snapshot still references. 404 CLAIM_NOT_FOUND / RECEIPT_NOT_FOUND; 503 store down.
 */
export const GET = defineRoute({
  auth: 'required',
  params: ReceiptParams,
  handler: async ({ serviceCtx, params }) =>
    fileAttachment(await receiptsService.download(serviceCtx, params.claimId, params.receiptId)),
});
