import { infiniteQueryOptions, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toSearch, type UrlParams } from '@/lib/use-url-query';
import { FinanceClaimSummaryPage } from '@/shared/dto/finance';

/**
 * Finance data access (05 §11). Read-only: the list is a cursor-paged infinite query over
 * GET /api/v1/finance/claims; the detail reuses the claims feature's queries; the CSV export is a
 * native browser download (`<a download>`), never fetched into JS memory, so it has no query here.
 */

/** The export endpoint; the page only ever adds `from` and `to` (never `status`). */
export const APPROVED_CLAIMS_EXPORT_PATH = '/api/v1/finance/exports/approved-claims';

/** `/api/v1/finance/exports/approved-claims?from=2026-09-01&to=2026-09-30` */
export const approvedClaimsExportHref = (period: { from: string; to: string }) =>
  `${APPROVED_CLAIMS_EXPORT_PATH}?${toSearch({ from: period.from, to: period.to })}`;

/**
 * GET /api/v1/finance/claims: every employee's claims, `<dateField> DESC, id DESC`, one cursor page
 * per "Load more". `params` are the URL's filter params, already validated by
 * `useUrlQuery(FinanceClaimsQuery)`, so the UI never sends a param the API would refuse.
 */
export const financeClaimsQuery = (params: UrlParams) =>
  infiniteQueryOptions({
    queryKey: qk.financeClaims(params),
    queryFn: ({ pageParam, signal }) => {
      const search = toSearch({ ...params, cursor: pageParam });
      return apiFetch(`/api/v1/finance/claims${search ? `?${search}` : ''}`, {
        schema: FinanceClaimSummaryPage,
        signal,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData, // no flicker while a new filter loads
  });
