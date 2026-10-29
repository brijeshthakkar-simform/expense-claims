'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorReference } from '@/components/common/error-reference';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useReject } from '@/features/approvals/api';
import { ApiError, applyServerIssues, describeApiError, type ApiIssue } from '@/lib/api-client';
import type { ClaimDetail } from '@/shared/dto/claims';
import { REJECT_REASON_LENGTH } from '@/shared/policy';
import { RejectInput } from '@/shared/schemas/claims';

/** The shared request schema's own `reason` rule: required, trimmed, 10..1000 (D-28, F4). */
const ReasonForm = RejectInput.pick({ reason: true });
type ReasonFormInput = z.input<typeof ReasonForm>;
type ReasonFormOutput = z.output<typeof ReasonForm>;

type Failure = { error: unknown; unmapped: ApiIssue[] };

/**
 * The reject dialog (05 §6.7): a reason the claimant will read, 10..1000 characters after trimming,
 * validated by the shared RejectInput rule; "Reject claim" stays disabled until it is valid. Like
 * approve, it captures `revision` when it opens.
 */
export function RejectDialog({
  claim,
  handleError,
}: {
  claim: ClaimDetail;
  /** The page's handler for codes that close the dialog; true = handled. */
  handleError: (e: unknown) => boolean;
}) {
  const router = useRouter();
  const reject = useReject(claim.id);
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(claim.currentRevision);
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm<ReasonFormInput, unknown, ReasonFormOutput>({
    resolver: zodResolver(ReasonForm),
    mode: 'onTouched', // the 10-character error shows once the field is left, then live
    defaultValues: { reason: '' },
  });
  const { errors, isValid } = form.formState;
  const reason = useWatch({ control: form.control, name: 'reason' }) ?? '';

  const onOpenChange = (next: boolean) => {
    if (reject.isPending) return; // keep it open until the server answers
    if (next) {
      setRevision(claim.currentRevision); // sign what is on screen now
      form.reset({ reason: '' });
      setFailure(null);
    }
    setOpen(next);
  };

  const onSubmit = form.handleSubmit(({ reason: trimmed }) => {
    setFailure(null);
    reject.mutate(
      { revision, reason: trimmed },
      {
        onSuccess: (dto) => {
          setOpen(false);
          toast.success(`${dto.claimNumber} rejected`, {
            description: `${dto.claimant.name} can see your reason, edit the claim and resubmit it.`,
          });
          router.push('/approvals');
        },
        onError: (e) => {
          if (handleError(e)) {
            setOpen(false);
            return;
          }
          const unmapped =
            e instanceof ApiError && e.code === 'VALIDATION_FAILED'
              ? applyServerIssues(e, form.setError, (p) => (p[0] === 'reason' ? 'reason' : null))
              : [];
          setFailure({ error: e, unmapped });
        },
      },
    );
  });

  const failed = failure === null ? null : describeApiError(failure.error);
  const reasonError = errors.reason;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="text-destructive">
          <X aria-hidden />
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Reject {claim.claimNumber}?</DialogTitle>
            <DialogDescription>
              The claim goes back to {claim.claimant.name} with your reason. Any later approval
              levels are cancelled; a resubmission restarts approval from level 1.
            </DialogDescription>
          </DialogHeader>

          {/* First focusable in the dialog, so Radix focuses it on open (autofocus, 05 §6.7). */}
          <Field data-invalid={!!reasonError || undefined}>
            <FieldLabel htmlFor={reasonId}>Reason for rejecting</FieldLabel>
            <Textarea
              id={reasonId}
              rows={4}
              maxLength={REJECT_REASON_LENGTH.max}
              aria-invalid={!!reasonError || undefined}
              aria-describedby={
                reasonError ? `${reasonId}-error ${reasonId}-hint` : `${reasonId}-hint`
              }
              {...form.register('reason')}
            />
            <FieldDescription id={`${reasonId}-hint`} className="flex justify-between gap-3">
              <span>The claimant sees this. At least {REJECT_REASON_LENGTH.min} characters.</span>
              <span className="tabular-nums">
                {reason.length} / {REJECT_REASON_LENGTH.max}
              </span>
            </FieldDescription>
            <FieldError id={`${reasonId}-error`} errors={[reasonError]} />
          </Field>

          {failed && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle className="line-clamp-none">The rejection didn’t go through</AlertTitle>
              <AlertDescription>
                <p>{failed.title}</p>
                {failure?.unmapped.map((issue, i) => (
                  <p key={i}>{issue.message}</p>
                ))}
                <ErrorReference id={failed.requestId} />
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={reject.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!isValid || reject.isPending}>
              {reject.isPending ? 'Rejecting…' : 'Reject claim'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
