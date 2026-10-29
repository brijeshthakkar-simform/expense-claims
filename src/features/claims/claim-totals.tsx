'use client';

import { useWatch, type Control } from 'react-hook-form';
import { Money } from '@/components/common/formatting';
import type { ClaimFormInput, ClaimFormOutput } from '@/features/claims/form-schema';
import { formatMinor, parseMoneyToMinor } from '@/shared/money';
import { MAX_CLAIM_TOTAL_MINOR } from '@/shared/policy';

/**
 * Two numbers, never confused (05 §6.5, §3.1): the saved total is the database's (`totalMinor`,
 * kept by triggers) and changes only after a save; the preview is integer arithmetic over what is
 * typed right now and is never sent.
 */

export function SavedTotal({ totalMinor }: { totalMinor: number | null }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground">Total (calculated by the database)</span>
      {totalMinor === null ? (
        <span className="text-muted-foreground">Not saved yet</span>
      ) : (
        <Money minor={totalMinor} data-testid="saved-total" className="text-base font-semibold" />
      )}
    </p>
  );
}

/** Isolated subscription: only this re-renders on each keystroke. */
export function UnsavedTotal({
  control,
}: {
  control: Control<ClaimFormInput, unknown, ClaimFormOutput>;
}) {
  const items = useWatch({ control, name: 'lineItems' }) ?? [];
  let total = 0;
  let invalid = 0;
  for (const li of items) {
    const r = parseMoneyToMinor(li?.amount ?? '');
    if (r.ok) total += r.value;
    else invalid += 1;
  }
  return (
    <p data-testid="unsaved-total" className="text-muted-foreground text-sm tabular-nums">
      Unsaved total (preview): {formatMinor(total)}
      {invalid > 0 &&
        ` · ${invalid} line${invalid === 1 ? '' : 's'} with a missing or invalid amount excluded`}
      {total > MAX_CLAIM_TOTAL_MINOR &&
        ` · exceeds the ${formatMinor(MAX_CLAIM_TOTAL_MINOR)} claim limit`}
    </p>
  );
}
