import { cn } from '@/lib/utils';
import { formatCalendarDate, formatInstant } from '@/shared/dates';
import { formatMinor } from '@/shared/money';

/**
 * Formatting primitives (05 §12–§13). Money is integer paise in, a string out (no float ever);
 * instants show in IST with a literal suffix; calendar dates are formatted from their own parts,
 * so the browser's timezone can't shift them.
 */

export function Money({
  minor,
  className,
  ...rest
}: { minor: number } & Omit<React.ComponentProps<'span'>, 'children'>) {
  return (
    <span className={cn('tabular-nums', className)} {...rest}>
      {formatMinor(minor)}
    </span>
  );
}

export function DateTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} className={className}>
      {formatInstant(iso)}
    </time>
  );
}

export function CalendarDate({ ymd, className }: { ymd: string; className?: string }) {
  return (
    <time dateTime={ymd} className={className}>
      {formatCalendarDate(ymd)}
    </time>
  );
}
