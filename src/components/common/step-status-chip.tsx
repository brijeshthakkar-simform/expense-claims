import { Ban, CheckCircle2, CircleDashed, Clock, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ApprovalStepStatus } from '@/shared/enums';

/**
 * One approval step's status as icon + text (05 §12 "Step chips"), never colour alone. Used by the
 * claim's approval chain now and the approver queue's "My decision" column later.
 */
export function StepStatusChip({
  status,
  className,
}: {
  status: ApprovalStepStatus;
  className?: string;
}) {
  const base = cn('gap-1', className);
  switch (status) {
    case 'WAITING':
      return (
        <Badge variant="outline" className={cn(base, 'text-muted-foreground')}>
          <CircleDashed aria-hidden />
          Waiting
        </Badge>
      );
    case 'PENDING':
      return (
        <Badge
          variant="outline"
          className={cn(base, 'border-amber-300 bg-amber-50 text-amber-900')}
        >
          <Clock aria-hidden />
          Pending
        </Badge>
      );
    case 'APPROVED':
      return (
        <Badge
          variant="outline"
          className={cn(base, 'border-emerald-300 bg-emerald-50 text-emerald-900')}
        >
          <CheckCircle2 aria-hidden />
          Approved
        </Badge>
      );
    case 'REJECTED':
      return (
        <Badge variant="destructive" className={base}>
          <XCircle aria-hidden />
          Rejected
        </Badge>
      );
    case 'CANCELLED':
      return (
        <Badge variant="outline" className={cn(base, 'text-muted-foreground line-through')}>
          <Ban aria-hidden />
          Cancelled
        </Badge>
      );
    default:
      // A value this build doesn't know yet: show it raw rather than guess (05 §12).
      return (
        <Badge variant="outline" className={base}>
          {String(status)}
        </Badge>
      );
  }
}
