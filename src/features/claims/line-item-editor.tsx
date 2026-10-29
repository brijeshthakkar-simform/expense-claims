'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type {
  FieldArrayWithId,
  FieldError,
  UseFieldArrayAppend,
  UseFieldArrayRemove,
  UseFormReturn,
} from 'react-hook-form';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  emptyLine,
  type ClaimFormInput,
  type ClaimFormOutput,
} from '@/features/claims/form-schema';
import type { ReceiptSlotProps } from '@/features/claims/receipts/line-receipts';
import { cn } from '@/lib/utils';
import { todayInBusinessTz } from '@/shared/dates';
import type { CategoryDto } from '@/shared/dto/categories';
import { parseMoneyToMinor, toDecimalString } from '@/shared/money';
import {
  DESCRIPTION_LENGTH,
  MAX_LINE_ITEMS,
  MERCHANT_MAX,
  MIN_EXPENSE_DATE,
} from '@/shared/policy';

type Form = UseFormReturn<ClaimFormInput, unknown, ClaimFormOutput>;
type Row = FieldArrayWithId<ClaimFormInput, 'lineItems'>;
type LineField = 'expenseDate' | 'categoryId' | 'description' | 'merchant' | 'amount';

// One grid for the header and every row: a table at ≥ lg, stacked cards below (05 §6.3).
const ROW_GRID =
  'grid grid-cols-2 gap-3 lg:grid-cols-[1.75rem_9.75rem_minmax(9rem,12rem)_minmax(0,1fr)_minmax(0,10rem)_9rem_2.25rem] lg:items-start lg:gap-2';

/**
 * Visible "Date" on small screens, visually hidden at ≥ lg (the header row labels the columns).
 * The accessible name is always "Date for line 2", which tests use as a stable selector.
 */
function RowLabel({ htmlFor, children, n }: { htmlFor: string; children: string; n: number }) {
  return (
    <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-normal lg:sr-only">
      {children}
      <span className="sr-only"> for line {n}</span>
    </Label>
  );
}

function RowError({ id, error }: { id: string; error?: FieldError }) {
  if (!error?.message) return null;
  return (
    <p id={id} className="text-destructive text-xs">
      {error.message}
    </p>
  );
}

/** aria-* wiring for a control and its (optional) error message. */
const describe = (id: string, error?: FieldError) => ({
  'aria-invalid': error ? true : undefined,
  'aria-describedby': error ? `${id}-error` : undefined,
});

export function LineItemEditor({
  form,
  rows,
  categories,
  append,
  remove,
  addRef: outerAddRef,
  receipts,
  receiptCounts,
}: {
  form: Form;
  rows: Row[];
  categories: CategoryDto[];
  append: UseFieldArrayAppend<ClaimFormInput, 'lineItems'>;
  remove: UseFieldArrayRemove;
  /** "Add line item", for the form to focus (e.g. after NO_LINE_ITEMS on submit). */
  addRef?: React.RefObject<HTMLButtonElement | null>;
  /** Each row's receipts section (05 §8), rendered under the row's fields. */
  receipts?: (line: ReceiptSlotProps) => React.ReactNode;
  /** Saved receipts per saved line id, so removing such a line confirms first (05 §6.3). */
  receiptCounts?: ReadonlyMap<string, number>;
}) {
  const { register, formState, getValues, setValue, setFocus } = form;
  const lineErrors = formState.errors.lineItems;
  const ownAddRef = useRef<HTMLButtonElement>(null);
  const addRef = outerAddRef ?? ownAddRef;
  const today = todayInBusinessTz();
  const atMax = rows.length >= MAX_LINE_ITEMS;

  // "450.5" → "450.50" and "1,250" → "1250.00" once the person leaves the field.
  const normaliseAmount = (index: number) => {
    const name = `lineItems.${index}.amount` as const;
    const raw = getValues(name);
    const r = parseMoneyToMinor(raw ?? '');
    if (r.ok && toDecimalString(r.value) !== raw) {
      setValue(name, toDecimalString(r.value), { shouldDirty: true });
    }
  };

  // Removing a saved line that has receipts asks first: saving then deletes them too.
  const [confirmRemove, setConfirmRemove] = useState<{ index: number; count: number } | null>(null);
  const removedRef = useRef(false);

  const removeRow = (index: number) => {
    remove(index);
    // Keep focus in the editor: the row that moved into this slot, else "Add line item".
    setTimeout(() => {
      if (index < rows.length - 1) setFocus(`lineItems.${index}.expenseDate`);
      else addRef.current?.focus();
    }, 0);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 && (
        <div
          aria-hidden
          className={cn(
            ROW_GRID,
            'text-muted-foreground hidden px-3 text-xs font-medium lg:grid lg:px-2',
          )}
        >
          <span>#</span>
          <span>Date</span>
          <span>Category</span>
          <span>Description</span>
          <span>Merchant (optional)</span>
          <span className="text-right">Amount (₹)</span>
          <span />
        </div>
      )}

      {rows.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
          No line items yet. A draft can be saved without lines; it needs at least one to be
          submitted.
        </p>
      )}

      <ol className="flex flex-col gap-3 lg:gap-2">
        {rows.map((row, index) => {
          const n = index + 1;
          const errs = lineErrors?.[index];
          const err = (f: LineField) => errs?.[f];
          const id = (f: LineField) => `li-${row.id}-${f}`;
          const amountReg = register(`lineItems.${index}.amount`);
          // Active categories, plus this row's saved category if it has since been retired, so the
          // row still renders; saving it then gets CATEGORY_INACTIVE on this row (05 §6.4).
          const options = categories.filter((c) => c.isActive || c.id === row.categoryId);
          return (
            <li
              key={row.id}
              aria-label={`Line ${n}`}
              className={cn(
                ROW_GRID,
                'rounded-md border p-3 lg:p-2',
                // With receipts under each row, a rule at ≥ lg keeps each row's receipts with it.
                receipts
                  ? 'lg:rounded-none lg:border-x-0 lg:border-t-0 lg:pb-3 lg:last:border-b-0'
                  : 'lg:border-0',
              )}
            >
              <span className="text-muted-foreground col-span-2 text-sm font-medium tabular-nums lg:col-span-1 lg:pt-2">
                <span className="lg:hidden">Line </span>
                {n}
              </span>

              <div className="flex flex-col gap-1">
                <RowLabel htmlFor={id('expenseDate')} n={n}>
                  Date
                </RowLabel>
                <Input
                  id={id('expenseDate')}
                  type="date"
                  min={MIN_EXPENSE_DATE}
                  max={today}
                  {...describe(id('expenseDate'), err('expenseDate'))}
                  {...register(`lineItems.${index}.expenseDate`)}
                />
                <RowError id={`${id('expenseDate')}-error`} error={err('expenseDate')} />
              </div>

              <div className="flex flex-col gap-1 [&>[data-slot=native-select-wrapper]]:w-full">
                <RowLabel htmlFor={id('categoryId')} n={n}>
                  Category
                </RowLabel>
                <NativeSelect
                  id={id('categoryId')}
                  {...describe(id('categoryId'), err('categoryId'))}
                  {...register(`lineItems.${index}.categoryId`)}
                >
                  <NativeSelectOption value="">Choose a category</NativeSelectOption>
                  {options.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.isActive ? c.name : `${c.name} (retired)`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <RowError id={`${id('categoryId')}-error`} error={err('categoryId')} />
              </div>

              <div className="col-span-2 flex flex-col gap-1 lg:col-span-1">
                <RowLabel htmlFor={id('description')} n={n}>
                  Description
                </RowLabel>
                <Input
                  id={id('description')}
                  autoComplete="off"
                  maxLength={DESCRIPTION_LENGTH.max}
                  {...describe(id('description'), err('description'))}
                  {...register(`lineItems.${index}.description`)}
                />
                <RowError id={`${id('description')}-error`} error={err('description')} />
              </div>

              <div className="flex flex-col gap-1">
                <RowLabel htmlFor={id('merchant')} n={n}>
                  Merchant
                </RowLabel>
                <Input
                  id={id('merchant')}
                  autoComplete="off"
                  maxLength={MERCHANT_MAX}
                  placeholder="Optional"
                  {...describe(id('merchant'), err('merchant'))}
                  {...register(`lineItems.${index}.merchant`)}
                />
                <RowError id={`${id('merchant')}-error`} error={err('merchant')} />
              </div>

              <div className="flex flex-col gap-1">
                <RowLabel htmlFor={id('amount')} n={n}>
                  Amount
                </RowLabel>
                <div className="relative">
                  <span
                    aria-hidden
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm"
                  >
                    ₹
                  </span>
                  {/* Never a number input: it accepts 1e3, changes on scroll and varies by locale. */}
                  <Input
                    id={id('amount')}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    className="pl-7 text-right tabular-nums"
                    {...describe(id('amount'), err('amount'))}
                    {...amountReg}
                    onBlur={(e) => {
                      void amountReg.onBlur(e).then(() => normaliseAmount(index));
                    }}
                  />
                </div>
                <RowError id={`${id('amount')}-error`} error={err('amount')} />
              </div>

              <div className="col-span-2 flex justify-end lg:col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove line ${n}`}
                  className="text-muted-foreground hover:text-destructive lg:size-9 lg:px-0"
                  onClick={() => {
                    const count = row.lineItemId ? (receiptCounts?.get(row.lineItemId) ?? 0) : 0;
                    if (count > 0) setConfirmRemove({ index, count });
                    else removeRow(index);
                  }}
                >
                  <Trash2 aria-hidden />
                  <span className="lg:sr-only">Remove</span>
                </Button>
              </div>

              {receipts && (
                <div className="col-span-2 border-t pt-3 lg:[grid-column:2/-1] lg:border-t-0 lg:pt-0">
                  {receipts({ lineItemId: row.lineItemId, n })}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={addRef}
          type="button"
          variant="outline"
          disabled={atMax}
          onClick={() => append(emptyLine(), { focusName: `lineItems.${rows.length}.expenseDate` })}
        >
          <Plus aria-hidden />
          Add line item
        </Button>
        {atMax && (
          <p className="text-muted-foreground text-sm">
            A claim can have at most {MAX_LINE_ITEMS} line items.
          </p>
        )}
      </div>

      <AlertDialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Removed: removeRow moves focus to the next row; kept: back to the Remove button.
            if (!removedRef.current) return;
            e.preventDefault();
            removedRef.current = false;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Remove line {(confirmRemove?.index ?? 0) + 1}?</AlertDialogTitle>
            <AlertDialogDescription>
              {`It has ${confirmRemove?.count === 1 ? '1 receipt' : `${confirmRemove?.count ?? 0} receipts`}. `}
              Saving the claim without this line also removes its receipts; earlier submitted
              revisions keep their copies.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep line</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRemove) {
                  removedRef.current = true;
                  removeRow(confirmRemove.index);
                }
                setConfirmRemove(null);
              }}
            >
              Remove line
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
