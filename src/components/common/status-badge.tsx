import { CheckCircle2, Clock, FilePen, Lock, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ClaimStatus } from '@/shared/enums';

/**
 * Claim status as icon + text, never colour alone (05 §12, WCAG 1.4.1). Display only: it never
 * gates an action (allowedActions does).
 */
export function StatusBadge({
  status,
  level,
  levelCount,
  className,
  ...rest
}: {
  status: ClaimStatus;
  /** The PENDING level while SUBMITTED, when known. */
  level?: number | null;
  levelCount?: number | null;
  className?: string;
  'data-testid'?: string;
}) {
  const base = cn('gap-1.5 px-2.5 py-1 text-xs', className);
  switch (status) {
    case 'DRAFT':
      return (
        <Badge variant="outline" className={base} {...rest}>
          <FilePen aria-hidden />
          Draft
        </Badge>
      );
    case 'SUBMITTED':
      return (
        <Badge
          variant="outline"
          className={cn(base, 'border-sky-300 bg-sky-50 text-sky-900')}
          {...rest}
        >
          <Clock aria-hidden />
          {level && levelCount ? `In approval · level ${level} of ${levelCount}` : 'In approval'}
        </Badge>
      );
    case 'APPROVED':
      return (
        <Badge
          variant="outline"
          className={cn(base, 'border-emerald-300 bg-emerald-50 text-emerald-900')}
          {...rest}
        >
          <CheckCircle2 aria-hidden />
          Approved · Locked
          <Lock aria-hidden />
        </Badge>
      );
    case 'REJECTED':
      return (
        <Badge variant="destructive" className={base} {...rest}>
          <XCircle aria-hidden />
          Rejected
        </Badge>
      );
  }
}
