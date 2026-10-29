'use client';

import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

/**
 * Filter controls for PagedTable lists (05 §10). They edit the URL through `useUrlQuery().set`,
 * which validates with the shared query schema first; nothing here filters rows in the browser.
 */

export function FilterBar({
  label,
  isFiltered,
  onClear,
  children,
  className,
}: {
  /** Accessible name of the filter region, e.g. "Filter my claims". */
  label: string;
  isFiltered: boolean;
  onClear: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <search
      aria-label={label}
      className={cn('flex flex-wrap items-end gap-x-4 gap-y-3', className)}
    >
      {children}
      {isFiltered && (
        <Button type="button" variant="ghost" onClick={onClear}>
          <X aria-hidden />
          Clear filters
        </Button>
      )}
    </search>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A labelled native <select>; `''` is the "no filter" option. */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const known = options.some((o) => o.value === value);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <NativeSelectOption key={o.value} value={o.value}>
            {o.label}
          </NativeSelectOption>
        ))}
        {/* A deep link may carry a combination the menu doesn't list: show it rather than lie. */}
        {!known && <NativeSelectOption value={value}>Custom selection</NativeSelectOption>}
      </NativeSelect>
    </div>
  );
}

// A type alias, not an interface, so it fits `UrlPatch` (interfaces have no index signature).
export type DateRangeValue = { from?: string; to?: string };

/**
 * Two native date inputs (YYYY-MM-DD, IST calendar days, both inclusive) under a legend naming the
 * field they filter ("Created date", "Routed to me between", "Decided between"). `onChange` returns
 * false when the shared schema refuses the range (`from` after `to`); the inputs then keep what the
 * user typed, show the error, and the URL stays as it was.
 */
export function DateRangeFilter({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState({ from: value.from ?? '', to: value.to ?? '' });
  const [error, setError] = useState<string | null>(null);
  // Follow the URL when it changes elsewhere (Clear, back/forward): adjust state while rendering,
  // the documented alternative to an effect.
  const [shown, setShown] = useState(value);
  if (shown.from !== value.from || shown.to !== value.to) {
    setShown(value);
    setDraft({ from: value.from ?? '', to: value.to ?? '' });
    setError(null);
  }

  const update = (field: 'from' | 'to', v: string) => {
    const next = { ...draft, [field]: v };
    setDraft(next);
    if (next.from && next.to && next.from > next.to) {
      setError('End date must be on or after start date');
      return;
    }
    const ok = onChange({ from: next.from || undefined, to: next.to || undefined });
    setError(ok ? null : 'End date must be on or after start date');
  };

  const errorId = `${id}-error`;
  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1.5 text-sm leading-none font-medium">
        {legend} <span className="text-muted-foreground font-normal">(IST)</span>
      </legend>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {(['from', 'to'] as const).map((field) => (
          // Each label stays on the same line as its input when the pair wraps on a phone.
          <span key={field} className="flex items-center gap-2">
            <Label htmlFor={`${id}-${field}`} className="text-muted-foreground w-9 font-normal">
              {field === 'from' ? 'From' : 'To'}
            </Label>
            <Input
              id={`${id}-${field}`}
              type="date"
              className="w-auto"
              value={draft[field]}
              min={field === 'to' ? draft.from || undefined : undefined}
              max={field === 'from' ? draft.to || undefined : undefined}
              aria-invalid={!!error || undefined}
              onChange={(e) => update(field, e.target.value)}
            />
          </span>
        ))}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </fieldset>
  );
}
