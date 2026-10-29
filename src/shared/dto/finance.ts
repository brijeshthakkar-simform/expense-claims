import { z } from 'zod';
import { ClaimSummary, PageInfo, UserRef } from '@/shared/dto/claims';

// C-10 / 04 §7.2 row 21: the finance list row is a ClaimSummary that always names its claimant
// (id, name, email), because finance reads every employee's claims. It still parses as a plain
// ClaimSummary, so the shared list components need no finance-specific type.

export const FinanceClaimSummary = ClaimSummary.extend({ claimant: UserRef });
export type FinanceClaimSummary = z.infer<typeof FinanceClaimSummary>;

/** `GET /api/v1/finance/claims` body: `{ data: FinanceClaimSummary[], page }`. */
export const FinanceClaimSummaryPage = z.object({
  data: z.array(FinanceClaimSummary),
  page: PageInfo,
});
export type FinanceClaimSummaryPage = z.infer<typeof FinanceClaimSummaryPage>;

/** Response headers of the CSV export (D-32), lower-case as `Headers.get` takes them. */
export const EXPORT_HEADERS = {
  /** ISO instant: the DB clock at request start; approvals at or after it are not in the file. */
  asOf: 'x-export-as-of',
  /** `true` while the period (plus the 2-minute settle window) has not ended: re-export later. */
  periodOpen: 'x-export-period-open',
} as const;

/** `approved-claims_2026-09-01_2026-09-30.csv` (Content-Disposition filename). */
export const exportFileName = (period: { from: string; to: string }): string =>
  `approved-claims_${period.from}_${period.to}.csv`;
