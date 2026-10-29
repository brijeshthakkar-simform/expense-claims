'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { ErrorReference } from '@/components/common/error-reference';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SavedTotal, UnsavedTotal } from '@/features/claims/claim-totals';
import { FormErrorSummary } from '@/features/claims/form-error-summary';
import {
  ClaimFormSchema,
  claimPathMap,
  emptyClaim,
  toFormValues,
  toReplacePayload,
  type ClaimFormInput,
  type ClaimFormOutput,
} from '@/features/claims/form-schema';
import { LineItemEditor } from '@/features/claims/line-item-editor';
import { LineItemsTable } from '@/features/claims/line-items-table';
import type { ReceiptSlotProps } from '@/features/claims/receipts/line-receipts';
import { ApiError, applyServerIssues, describeApiError, type ApiIssue } from '@/lib/api-client';
import type { CategoryDto } from '@/shared/dto/categories';
import type { ClaimDetail } from '@/shared/dto/claims';
import { TITLE_LENGTH } from '@/shared/policy';
import type { ReplaceClaimInput } from '@/shared/schemas/claims';

export interface SaveOptions {
  /** This save is the first half of "Save & submit"; the screen may skip its "saved" toast. */
  thenSubmit?: boolean;
}

export interface ClaimFormProps {
  /** Absent on /claims/new (create mode). */
  claim?: ClaimDetail;
  categories: CategoryDto[];
  /** Sends the payload (POST or PUT) and resolves with the server's fresh ClaimDetail. */
  onSave: (payload: ReplaceClaimInput, options?: SaveOptions) => Promise<ClaimDetail>;
  /**
   * Side effects for codes the screen owns (reload dialog, refetch, cache invalidation). Return
   * true when the screen has shown the error itself, so the form shows no alert of its own.
   */
  onSaveError?: (error: unknown) => boolean;
  /**
   * POST …/submit for the saved claim, resolving with the server's fresh ClaimDetail. Submit and
   * "Save & submit" render only when this is given and allowedActions contains SUBMIT.
   */
  onSubmitClaim?: () => Promise<ClaimDetail>;
  /** As onSaveError, for a refused submit. */
  onSubmitError?: (error: unknown) => boolean;
  /**
   * Each editable row's receipts section (05 §8). A slot, so this form stays presentational: the
   * screen supplies attach/remove for saved lines, or the "save first" hint for unsaved ones.
   */
  receipts?: (line: ReceiptSlotProps) => React.ReactNode;
}

type Failure =
  | { kind: 'save'; error: unknown; unmapped: ApiIssue[] }
  /** `saved`: the save half of "Save & submit" went through, only the submit was refused. */
  | { kind: 'submit'; error: unknown; unmapped: ApiIssue[]; saved: boolean };

/** Which request is in flight: a plain save, the save half of "Save & submit", or the submit. */
type Busy = 'save' | 'presave' | 'submit' | null;

const isCode = (e: unknown, code: string): e is ApiError =>
  e instanceof ApiError && e.code === code;

/**
 * The claim editor (05 §6.3). Presentational: props in, callbacks out, no fetching, so the
 * component test needs no network mocks. It renders editable only when the server's
 * allowedActions contains EDIT, and offers Submit only when it contains SUBMIT; the server
 * re-decides on every call anyway.
 */
export function ClaimForm({
  claim,
  categories,
  onSave,
  onSaveError,
  onSubmitClaim,
  onSubmitError,
  receipts,
}: ClaimFormProps) {
  const editable = !claim || claim.allowedActions.includes('EDIT');
  const canSubmit = !!claim && !!onSubmitClaim && claim.allowedActions.includes('SUBMIT');
  const form = useForm<ClaimFormInput, unknown, ClaimFormOutput>({
    resolver: zodResolver(ClaimFormSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: claim ? toFormValues(claim) : emptyClaim(),
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const { errors, isDirty, isSubmitting, submitCount } = form.formState;
  const [failure, setFailure] = useState<Failure | null>(null);
  // NO_LINE_ITEMS belongs to the Line items section, not the top alert (05 §5.2).
  const [linesError, setLinesError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const addLineRef = useRef<HTMLButtonElement>(null);

  // Reset rule: follow the server's copy only while clean, so a focus refetch never wipes edits.
  // A refetch that changes nothing the inputs show (e.g. a receipt was attached) keeps the rows
  // mounted, so focus and each line's receipt messages survive it.
  useEffect(() => {
    if (!claim || form.formState.isDirty) return;
    const next = toFormValues(claim);
    if (!sameValues(next, form.getValues())) form.reset(next);
  }, [claim, form]);

  const receiptCounts = useMemo(
    () => new Map(claim?.lineItems.map((li) => [li.id, li.receipts.length])),
    [claim],
  );

  const clearFailures = () => {
    setFailure(null);
    setLinesError(null);
  };

  /** Server issues onto their fields; returns the ones no field can show. */
  const placeIssues = (e: unknown): ApiIssue[] =>
    e instanceof ApiError && e.details?.issues?.length
      ? applyServerIssues(e, form.setError, claimPathMap)
      : [];

  /** Saves and re-bases the form on the server's copy (new rows get their ids); null if refused. */
  const persist = async (values: ClaimFormOutput, thenSubmit: boolean) => {
    try {
      const payload = toReplacePayload(values);
      const dto = await (thenSubmit ? onSave(payload, { thenSubmit }) : onSave(payload));
      form.reset(toFormValues(dto));
      return dto;
    } catch (e) {
      const unmapped = placeIssues(e);
      if (onSaveError?.(e)) return null;
      if (isCode(e, 'VALIDATION_FAILED') && unmapped.length === 0) return null;
      setFailure({ kind: 'save', error: e, unmapped });
      return null;
    }
  };

  /** The submit call itself. On success the screen caches the DTO, whose actions lack EDIT. */
  const submitSaved = async (saved: boolean) => {
    if (!onSubmitClaim) return;
    setBusy('submit');
    try {
      await onSubmitClaim();
    } catch (e) {
      const unmapped = placeIssues(e);
      if (onSubmitError?.(e)) return;
      if (isCode(e, 'NO_LINE_ITEMS')) {
        setLinesError(describeApiError(e).title);
        addLineRef.current?.focus();
        return;
      }
      setFailure({ kind: 'submit', error: e, unmapped, saved });
    }
  };

  const save = form.handleSubmit(async (values) => {
    clearFailures();
    setBusy('save');
    try {
      await persist(values, false);
    } finally {
      setBusy(null);
    }
  });

  // "Save & submit" is two atomic calls in sequence; if the save fails we stop (05 §6.6).
  const saveAndSubmit = form.handleSubmit(async (values) => {
    clearFailures();
    setBusy('presave');
    try {
      if (await persist(values, true)) await submitSaved(true);
    } finally {
      setBusy(null);
    }
  });

  // Clean form: the saved copy is what gets submitted, so there is nothing to save first.
  const submitOnly = async () => {
    clearFailures();
    try {
      await submitSaved(false);
    } finally {
      setBusy(null);
    }
  };

  const working = isSubmitting || busy !== null;
  // Labels only; a dirty form is saved first so the submitted copy is what's on screen (05 §7).
  const resubmit = claim?.status === 'REJECTED';
  const submitLabel = isDirty
    ? resubmit
      ? 'Save & resubmit'
      : 'Save & submit'
    : resubmit
      ? 'Resubmit'
      : 'Submit';
  // The server's NO_LINE_ITEMS is the authority; this only saves a pointless round trip (05 §6.3).
  const noLines = fields.length === 0;
  const submitButton = canSubmit && (
    <Button
      type="button"
      disabled={working || noLines}
      aria-describedby={noLines ? 'submit-hint' : undefined}
      onClick={() => void (isDirty ? saveAndSubmit() : submitOnly())}
    >
      <Send aria-hidden />
      {busy === 'presave' ? 'Saving…' : busy === 'submit' ? 'Submitting…' : submitLabel}
    </Button>
  );
  const submitHint = canSubmit && noLines && (
    <p id="submit-hint" className="text-muted-foreground text-sm">
      Add at least one line item
    </p>
  );
  const retry = () => {
    if (failure?.kind !== 'submit') void save();
    else void (isDirty ? saveAndSubmit() : submitOnly());
  };
  const failureAlert = failure && <ActionFailureAlert failure={failure} onRetry={retry} />;

  if (!editable && claim) {
    return (
      <div className="flex flex-col gap-4">
        {failureAlert}
        <h2 className="text-lg font-semibold">Line items</h2>
        <LineItemsTable lines={claim.lineItems} caption="Line items" claimId={claim.id} />
        <SavedTotal totalMinor={claim.totalMinor} />
        {canSubmit && (
          <div className="flex flex-col items-end gap-2 border-t pt-4">
            {submitButton}
            {submitHint}
          </div>
        )}
      </div>
    );
  }

  const discard = () => {
    clearFailures();
    form.reset(claim ? toFormValues(claim) : emptyClaim());
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-6">
      {failureAlert}
      {submitCount > 0 && <FormErrorSummary errors={errors} onFocus={form.setFocus} />}

      <Field data-invalid={!!errors.title || undefined} className="max-w-xl">
        <FieldLabel htmlFor="claim-title">Title</FieldLabel>
        <Input
          id="claim-title"
          autoComplete="off"
          maxLength={TITLE_LENGTH.max}
          aria-invalid={!!errors.title || undefined}
          aria-describedby={errors.title ? 'claim-title-error' : 'claim-title-hint'}
          {...form.register('title')}
        />
        {errors.title ? (
          <FieldError id="claim-title-error" errors={[errors.title]} />
        ) : (
          <FieldDescription id="claim-title-hint">
            {TITLE_LENGTH.min}–{TITLE_LENGTH.max} characters, e.g. &ldquo;Client visit, Pune&rdquo;.
          </FieldDescription>
        )}
      </Field>

      <fieldset
        className="flex flex-col gap-3"
        aria-describedby={linesError ? 'line-items-error' : undefined}
      >
        <legend className="mb-3 text-lg font-semibold">Line items</legend>
        {linesError && (
          <p id="line-items-error" role="alert" className="text-destructive text-sm font-medium">
            {linesError}
          </p>
        )}
        <LineItemEditor
          form={form}
          rows={fields}
          categories={categories}
          append={append}
          remove={remove}
          addRef={addLineRef}
          receipts={receipts}
          receiptCounts={receiptCounts}
        />
      </fieldset>

      <div className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <SavedTotal totalMinor={claim ? claim.totalMinor : null} />
          {(isDirty || !claim) && <UnsavedTotal control={form.control} />}
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {claim && isDirty && (
              <Button type="button" variant="outline" onClick={discard} disabled={working}>
                Discard changes
              </Button>
            )}
            {/* The only submit-type button, so Enter in a field saves and never submits. */}
            <Button type="submit" variant={canSubmit ? 'outline' : 'default'} disabled={working}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </Button>
            {submitButton}
          </div>
          {submitHint}
        </div>
      </div>
    </form>
  );
}

/** Structural equality for form values (plain JSON: strings, arrays, objects). */
function sameValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.length === Object.keys(b).length && ka.every((k) => sameValues(ra[k], rb[k]));
}

/** Non-field failures: always on the page (role="alert"), never only in a toast (05 §14). */
function ActionFailureAlert({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const d = describeApiError(failure.error);
  const retryable = isCode(failure.error, 'CONFLICT');
  let title: string;
  if (failure.kind === 'save') title = `The claim was not saved. ${d.title}`;
  // That copy already says "The claim was not submitted." and never says why (HR privacy).
  else if (isCode(failure.error, 'ROUTING_UNRESOLVABLE')) title = d.title;
  else title = `The claim was not submitted. ${d.title}`;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription>
        {failure.kind === 'submit' && failure.saved && (
          <p>Your changes were saved, and you can keep editing.</p>
        )}
        {failure.unmapped.length > 0 && (
          <ul className="list-disc pl-4">
            {failure.unmapped.map((issue, i) => (
              <li key={`${issue.path.join('.')}-${i}`}>{issue.message}</li>
            ))}
          </ul>
        )}
        {retryable && (
          // Manual only: a state change is never retried automatically (F2).
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry}>
            Try again
          </Button>
        )}
        <ErrorReference id={d.requestId} />
      </AlertDescription>
    </Alert>
  );
}
