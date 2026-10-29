import { defineRoute } from '@/server/http/define-route';
import { csvDownload } from '@/server/http/responses';
import * as exportService from '@/server/services/export.service';
import { EXPORT_HEADERS } from '@/shared/dto/finance';
import { ExportQuery } from '@/shared/schemas/queries';

/**
 * GET /api/v1/finance/exports/approved-claims?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=APPROVED]
 * → 200 `text/csv; charset=utf-8`, streamed (D-32, 06 §6): one row per line item of every claim
 * whose FINAL approval falls in the IST period and before X-Export-As-Of. Headers:
 * Content-Disposition `attachment; filename="approved-claims_<from>_<to>.csv"`, X-Export-As-Of,
 * X-Export-Period-Open. Gate FINANCE (403 FORBIDDEN); `Sec-Fetch-Site: cross-site` → 403
 * CSRF_REJECTED (the only GET with weight, 04 §2.6); 422 VALIDATION_FAILED (`from > to`),
 * EXPORT_RANGE_TOO_LARGE (> 366 days), EXPORT_STATUS_NOT_ALLOWED (status ≠ APPROVED); 503 if the
 * DB is down at the start. A failure after the first byte aborts the response (failed download).
 */
export const GET = defineRoute({
  auth: 'required',
  roles: ['FINANCE'],
  query: ExportQuery,
  handler: async ({ serviceCtx, query }) => {
    const x = await exportService.openApprovedClaimsExport(serviceCtx, query);
    return csvDownload({
      body: x.stream,
      fileName: x.fileName,
      headers: {
        [EXPORT_HEADERS.asOf]: x.asOf.toISOString(),
        [EXPORT_HEADERS.periodOpen]: String(x.periodOpen),
      },
    });
  },
});
