import { defineRoute } from '@/server/http/define-route';
import { readReceiptFile } from '@/server/http/multipart';
import { created } from '@/server/http/responses';
import * as receiptsService from '@/server/services/receipts.service';
import { LineItemReceiptsParams } from '@/shared/schemas/claims';

/**
 * POST /api/v1/claims/:claimId/line-items/:lineItemId/receipts → 201 `{ data: ReceiptDto }`.
 * multipart/form-data with a single `file` (≤ default 10 MiB, see policy.ts; JPEG, PNG, WEBP or
 * PDF, proven by magic bytes) on a line of my DRAFT/REJECTED claim. 404 CLAIM_NOT_FOUND /
 * LINE_ITEM_NOT_FOUND; 409 CLAIM_NOT_EDITABLE / CLAIM_LOCKED; 413 PAYLOAD_TOO_LARGE; 415; 422
 * RECEIPT_TYPE_NOT_ALLOWED / RECEIPT_LIMIT_REACHED / VALIDATION_FAILED; 503 when the object store
 * is down.
 */
export const POST = defineRoute({
  auth: 'required',
  params: LineItemReceiptsParams,
  body: 'multipart',
  handler: async ({ req, serviceCtx, params }) => {
    const file = await readReceiptFile(req); // Content-Length cap before reading, then byte-limited
    return created(
      await receiptsService.upload(serviceCtx, params.claimId, params.lineItemId, file),
    );
  },
});
