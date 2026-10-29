import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { DateTime, Money } from '@/components/common/formatting';
import { StepStatusChip } from '@/components/common/step-status-chip';
import type { Column } from '@/components/lists/paged-table';
import { Badge } from '@/components/ui/badge';
import type { ApprovalTask } from '@/shared/dto/approvals';

/** Column configs for /approvals (05 §10.3): Pending, and Decided with my decision added. */

export type QueueTab = 'pending' | 'decided';

/** Instants wrap ("14 Oct 2026, / 7:48 pm IST") so the table fits narrower screens. */
const WHEN = 'min-w-28 whitespace-normal';

const claimNumber: Column<ApprovalTask> = {
  id: 'claimNumber',
  header: 'Claim #',
  rowHeader: true,
  cell: (t) => (
    <Link
      href={`/approvals/${t.claimId}`}
      className="font-mono underline-offset-4 hover:underline"
      data-testid="claim-link"
    >
      {t.claimNumber}
    </Link>
  ),
};

const employee: Column<ApprovalTask> = {
  id: 'employee',
  header: 'Employee',
  cell: (t) => t.claimant.name,
};

const title: Column<ApprovalTask> = {
  id: 'title',
  header: 'Title',
  className: 'min-w-48 whitespace-normal break-words',
  cell: (t) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{t.title}</span>
      {t.revision > 1 && (
        <Badge variant="outline" className="gap-1">
          <RotateCcw aria-hidden />
          Resubmitted (rev {t.revision})
        </Badge>
      )}
    </div>
  ),
};

const level: Column<ApprovalTask> = {
  id: 'level',
  header: 'Level',
  cell: (t) => (
    <span>
      <span className="tabular-nums">
        {t.level} of {t.levelCount}
      </span>
      <span className="text-muted-foreground"> · {t.tierLabel}</span>
    </span>
  ),
};

const amount: Column<ApprovalTask> = {
  id: 'amount',
  header: 'Amount',
  align: 'end',
  cell: (t) => <Money minor={t.amountMinor} />,
};

const routed: Column<ApprovalTask> = {
  id: 'routed',
  header: 'Routed to me',
  className: WHEN,
  cell: (t) => <DateTime iso={t.activatedAt} />,
};

const decision: Column<ApprovalTask> = {
  id: 'decision',
  header: 'My decision',
  cell: (t) => <StepStatusChip status={t.status} />,
};

const decidedAt: Column<ApprovalTask> = {
  id: 'decidedAt',
  header: 'Decided',
  className: WHEN,
  cell: (t) => (t.decidedAt ? <DateTime iso={t.decidedAt} /> : '—'),
};

const PENDING = [claimNumber, employee, title, level, amount, routed] as const;
const DECIDED = [...PENDING, decision, decidedAt] as const;

export const queueColumns = (tab: QueueTab): readonly Column<ApprovalTask>[] =>
  tab === 'pending' ? PENDING : DECIDED;
