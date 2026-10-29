'use client';

import { CalendarClock, Download } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { CalendarDate } from '@/components/common/formatting';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { approvedClaimsExportHref } from '@/features/finance/api';
import { cn } from '@/lib/utils';
import { inclusiveDays, isValidYmd, monthPeriod } from '@/shared/dates';
import { exportFileName } from '@/shared/dto/finance';
import { EXPORT_MAX_RANGE_DAYS } from '@/shared/policy';
import { ExportQuery } from '@/shared/schemas/queries';

/**
 * /finance/export (05 §11, §3.6): pick a period of IST calendar days, then download the approved
 * claims as CSV through a native `<a download>`. The browser streams the file straight to disk (no
 * blob in JS memory), the session cookie rides along, and the top-level same-origin navigation
 * sends `Sec-Fetch-Site: same-origin`, so the export's CSRF check passes.
 *
 * The period is validated with the API's own ExportQuery schema plus the EXPORT_MAX_RANGE_DAYS span
 * rule, so VALIDATION_FAILED / EXPORT_RANGE_TOO_LARGE can't be triggered from here. The page never
 * sends `status` (the server would accept only APPROVED anyway).
 */

type Preset = 'lastMonth' | 'thisMonth' | 'custom';

const PRESETS: readonly { value: Preset; label: string; offset?: number }[] = [
  { value: 'lastMonth', label: 'Last month', offset: -1 }, // the default: month-end close
  { value: 'thisMonth', label: 'This month', offset: 0 },
  { value: 'custom', label: 'Custom' },
];

export interface ExportPeriod {
  from: string;
  to: string;
}

export type PeriodCheck =
  | { ok: true; period: ExportPeriod; days: number }
  | { ok: false; errors: { from?: string; to?: string } };

/** The page's validation: field messages first, then the shared ExportQuery as the final word. */
export function checkExportPeriod(from: string, to: string): PeriodCheck {
  const errors: { from?: string; to?: string } = {};
  if (!from) errors.from = 'Choose a start date';
  else if (!isValidYmd(from)) errors.from = 'Use a real date';
  if (!to) errors.to = 'Choose an end date';
  else if (!isValidYmd(to)) errors.to = 'Use a real date';
  if (errors.from || errors.to) return { ok: false, errors };

  if (from > to) return { ok: false, errors: { to: 'End date must be on or after start date' } };
  const days = inclusiveDays(from, to);
  if (days > EXPORT_MAX_RANGE_DAYS) {
    return {
      ok: false,
      errors: { to: `Export at most ${EXPORT_MAX_RANGE_DAYS} days at a time` },
    };
  }

  const parsed = ExportQuery.safeParse({ from, to });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === 'from' ? 'from' : 'to';
    return { ok: false, errors: { [field]: issue?.message ?? 'Check the dates' } };
  }
  return { ok: true, period: { from, to }, days };
}

export function ExportForm({ today }: { /** Today in IST (YYYY-MM-DD). */ today: string }) {
  const id = useId();
  const fromRef = useRef<HTMLInputElement>(null);
  const [preset, setPreset] = useState<Preset>('lastMonth');
  const [period, setPeriod] = useState<ExportPeriod>(() => monthPeriod(today, -1));

  const choosePreset = (next: Preset) => {
    setPreset(next);
    const offset = PRESETS.find((p) => p.value === next)?.offset;
    // Custom keeps the current dates and moves focus to them; the month presets refill both.
    if (offset === undefined) fromRef.current?.focus();
    else setPeriod(monthPeriod(today, offset));
  };
  const editDate = (field: keyof ExportPeriod, value: string) => {
    setPreset('custom');
    setPeriod((p) => ({ ...p, [field]: value }));
  };

  const check = checkExportPeriod(period.from, period.to);
  const errors = check.ok ? {} : check.errors;
  const periodOpen = check.ok && check.period.to >= today;
  const statusId = `${id}-status`;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Includes every claim whose <strong className="text-foreground">final approval</strong>{' '}
        happened between these dates (inclusive, IST). One row per line item; UTF-8 CSV that opens
        in Excel. In-flight, rejected and draft claims are never included. An empty period downloads
        a header-only file.
      </p>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm leading-none font-medium">Period</legend>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <label
              key={p.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]',
                preset === p.value
                  ? 'border-primary bg-primary/5'
                  : 'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <input
                type="radio"
                name={`${id}-preset`}
                value={p.value}
                checked={preset === p.value}
                onChange={() => choosePreset(p.value)}
                className="accent-primary size-4"
              />
              {p.label}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-3">
          {(['from', 'to'] as const).map((field) => {
            const inputId = `${id}-${field}`;
            const error = errors[field];
            return (
              <Field key={field} data-invalid={!!error || undefined} className="w-auto">
                <FieldLabel htmlFor={inputId}>
                  {field === 'from' ? 'From' : 'To'}{' '}
                  <span className="text-muted-foreground font-normal">(IST)</span>
                </FieldLabel>
                <Input
                  ref={field === 'from' ? fromRef : undefined}
                  id={inputId}
                  type="date"
                  required
                  className="w-auto"
                  value={period[field]}
                  aria-invalid={!!error || undefined}
                  aria-describedby={error ? `${inputId}-error` : undefined}
                  onChange={(e) => editDate(field, e.target.value)}
                />
                <FieldError id={`${inputId}-error`} errors={error ? [{ message: error }] : []} />
              </Field>
            );
          })}
        </div>
      </fieldset>

      {periodOpen && (
        <Alert role="status" data-testid="period-open-hint">
          <CalendarClock aria-hidden />
          <AlertTitle className="line-clamp-none">This period hasn’t ended yet</AlertTitle>
          <AlertDescription>
            Approvals made after you download won’t be in this file; export again after it closes.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {check.ok ? (
          <Button asChild>
            {/* A native download: no fetch, no blob, no `status` param (05 §11). */}
            <a
              href={approvedClaimsExportHref(check.period)}
              download={exportFileName(check.period)}
              aria-describedby={statusId}
              data-testid="export-download"
            >
              <Download aria-hidden />
              Download CSV
            </a>
          </Button>
        ) : (
          <Button type="button" disabled aria-describedby={statusId} data-testid="export-download">
            <Download aria-hidden />
            Download CSV
          </Button>
        )}
        <p id={statusId} aria-live="polite" className="text-muted-foreground text-sm">
          {check.ok ? (
            <>
              Approved between <CalendarDate ymd={check.period.from} /> and{' '}
              <CalendarDate ymd={check.period.to} /> ({check.days}{' '}
              {check.days === 1 ? 'day' : 'days'})
            </>
          ) : (
            'Choose a valid period to download.'
          )}
        </p>
      </div>
    </div>
  );
}
