import Link from 'next/link';
import { DateTime, Money } from '@/components/common/formatting';
import { StatusBadge } from '@/components/common/status-badge';
import type { Column } from '@/components/lists/paged-table';
import type { ClaimSummary } from '@/shared/dto/claims';

/** Column config for /claims (05 §4.2): the page is a thin wrapper around PagedTable. */

const NONE = <span className="text-muted-foreground">—</span>;
/** Instants wrap ("14 Oct 2026, / 7:48 pm IST") so the table fits narrower screens. */
const WHEN = 'min-w-28 whitespace-normal';

export const myClaimsColumns: readonly Column<ClaimSummary>[] = [
  {
    id: 'claimNumber',
    header: 'Claim #',
    rowHeader: true,
    cell: (c) => (
      <Link
        href={`/claims/${c.id}`}
        className="font-mono underline-offset-4 hover:underline"
        data-testid="claim-link"
      >
        {c.claimNumber}
      </Link>
    ),
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
    id: 'created',
    header: 'Created',
    className: WHEN,
    cell: (c) => <DateTime iso={c.createdAt} />,
  },
  {
    id: 'submitted',
    header: 'Submitted',
    className: WHEN,
    cell: (c) => (c.submittedAt ? <DateTime iso={c.submittedAt} /> : NONE),
  },
  { id: 'lines', header: 'Lines', align: 'end', cell: (c) => c.lineItemCount },
  { id: 'total', header: 'Total', align: 'end', cell: (c) => <Money minor={c.totalMinor} /> },
];
