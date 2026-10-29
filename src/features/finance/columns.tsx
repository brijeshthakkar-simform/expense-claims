import Link from 'next/link';
import { DateTime, Money } from '@/components/common/formatting';
import { StatusBadge } from '@/components/common/status-badge';
import type { Column } from '@/components/lists/paged-table';
import type { FinanceClaimSummary } from '@/shared/dto/finance';

/**
 * Column config for /finance/claims (05 §11): a plain table (C-24 cut item 3 applied up front), so
 * the page is a thin wrapper around the shared PagedTable. Read-only: the claim number opens the
 * finance detail view, nothing else is actionable.
 */

const NONE = <span className="text-muted-foreground">—</span>;
/** Instants wrap ("14 Oct 2026, / 7:48 pm IST") so the table fits narrower screens. */
const WHEN = 'min-w-28 whitespace-normal';

export const financeColumns: readonly Column<FinanceClaimSummary>[] = [
  {
    id: 'claimNumber',
    header: 'Claim #',
    rowHeader: true,
    cell: (c) => (
      <Link
        href={`/finance/claims/${c.id}`}
        className="font-mono underline-offset-4 hover:underline"
        data-testid="claim-link"
      >
        {c.claimNumber}
      </Link>
    ),
  },
  {
    id: 'employee',
    header: 'Employee',
    cell: (c) => c.claimant.name,
  },
  {
    id: 'title',
    header: 'Title',
    className: 'min-w-48 whitespace-normal break-words',
    cell: (c) => c.title,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (c) => <StatusBadge status={c.status} level={c.currentLevel} levelCount={c.levelCount} />,
  },
  {
    id: 'submitted',
    header: 'Submitted',
    className: WHEN,
    cell: (c) => (c.submittedAt ? <DateTime iso={c.submittedAt} /> : NONE),
  },
  {
    id: 'approved',
    header: 'Approved',
    className: WHEN,
    cell: (c) => (c.approvedAt ? <DateTime iso={c.approvedAt} /> : NONE),
  },
  { id: 'total', header: 'Total', align: 'end', cell: (c) => <Money minor={c.totalMinor} /> },
];
