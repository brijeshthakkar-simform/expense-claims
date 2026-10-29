import 'server-only';
import { requireRole } from '@/server/auth/actor';
import { AppError } from '@/server/errors/app-error';
import * as financeRepo from '@/server/repositories/finance.repo';
import { toFinanceClaimSummary } from '@/server/services/claim-dto';
import type { ServiceCtx } from '@/server/services/context';
import { CursorError, decodeCursor, encodeCursor, type CursorFilters } from '@/shared/cursor';
import { businessDayRangeToUtc } from '@/shared/dates';
import type { FinanceClaimSummary } from '@/shared/dto/finance';
import type { FinanceClaimsQuery, FinanceDateField } from '@/shared/schemas/queries';

// Finance reads (§3.5-c, D-04, D-26): every employee's claims, read-only. The first line of every
// function is requireRole(ctx.actor, 'FINANCE'), so the service guards itself even if a caller
// skips the route's role gate (RT-M11); the repository's scope financeClaimsWhere(actor) refuses
// again. A finance claim detail is the ordinary GET /claims/:id: claimVisibilityWhere already lets
// FINANCE read every claim, and decide() offers finance no actions (allowedActions: []).

export { financeClaimsWhere } from '@/server/repositories/claim-visibility';

/** The fixed sort of GET /finance/claims per dateField, bound into every cursor it issues. */
export const FINANCE_CLAIMS_SORT: Readonly<Record<FinanceDateField, string>> = {
  submittedAt: 'submittedAt:desc',
  approvedAt: 'approvedAt:desc',
};

export interface FinanceClaimPage {
  items: FinanceClaimSummary[];
  nextCursor: string | null;
  limit: number;
}

/**
 * GET /api/v1/finance/claims: all claimants' claims, `<dateField> DESC, id DESC`, keyset-paginated
 * (C-09). DRAFT is listed only when `status` names it; `from`/`to` (IST days) filter `dateField`.
 */
export async function listFinanceClaims(
  ctx: ServiceCtx,
  query: FinanceClaimsQuery,
): Promise<FinanceClaimPage> {
  requireRole(ctx.actor, 'FINANCE');
  const sort = FINANCE_CLAIMS_SORT[query.dateField];
  const filters: CursorFilters = {
    status: query.status,
    dateField: query.dateField,
    from: query.from,
    to: query.to,
  };
  const rows = await financeRepo.listForFinance(ctx.actor, {
    statuses: query.status,
    dateField: query.dateField,
    range: businessDayRangeToUtc(query.from, query.to),
    after: query.cursor === undefined ? undefined : readCursor(query.cursor, sort, filters),
    take: query.limit + 1, // one extra row says whether there is a next page
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? encodeCursor(
          sort,
          { value: last[query.dateField]?.toISOString() ?? null, id: last.id },
          filters,
        )
      : null;
  return { items: page.map(toFinanceClaimSummary), nextCursor, limit: query.limit };
}

function readCursor(
  raw: string,
  sort: string,
  filters: CursorFilters,
): { value: Date | null; id: string } {
  try {
    const pos = decodeCursor(raw, sort, filters);
    return { value: pos.value === null ? null : new Date(pos.value), id: pos.id };
  } catch (err) {
    if (err instanceof CursorError) throw new AppError('INVALID_CURSOR');
    throw err;
  }
}
