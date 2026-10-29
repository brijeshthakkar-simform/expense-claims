'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Undo2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ErrorReference } from '@/components/common/error-reference';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRecallClaim } from '@/features/claims/api';
import { ApiError, describeApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type { ApprovalStepDto, ClaimDetail } from '@/shared/dto/claims';
import { RECALL_NOTE_MAX } from '@/shared/policy';

/** The claim moved on while the dialog was open: say so, close, and show the server's state. */
const MOVED_ON = new Set(['INVALID_STATUS_TRANSITION', 'CLAIM_LOCKED', 'CLAIM_NOT_FOUND']);

const names = (steps: readonly ApprovalStepDto[]) => {
  const list = steps.map((s) => s.approver.name);
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
};

const levels = (steps: readonly ApprovalStepDto[]) =>
  `level${steps.length === 1 ? '' : 's'} ${steps.map((s) => s.level).join(', ')}`;

/**
 * "Recall claim" (05 §6.7, 02 §6.3): rendered only when allowedActions contains RECALL (an
 * owner's SUBMITTED claim). The copy is built from the current chain so the §3.2 amount-change
 * rule is in the user's words: approvals so far are voided, and the next submit routes from
 * level 1 on the new total. The server re-decides; a 409 here means it was decided or recalled
 * meanwhile, and the view refetches to show what the server now allows.
 */
export function RecallDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: ClaimDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const recall = useRecallClaim(claim.id);
  const noteId = useId();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(null);

  const steps = claim.approval?.steps ?? [];
  const approved = steps.filter((s) => s.status === 'APPROVED');
  const pending = steps.find((s) => s.status === 'PENDING');

  const change = (next: boolean) => {
    if (recall.isPending) return; // keep it open until the server answers
    if (next) {
      setNote('');
      setFailure(null);
    }
    onOpenChange(next);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.claim(claim.id) });
    void qc.invalidateQueries({ queryKey: qk.history(claim.id) });
  };

  const confirm = () => {
    setFailure(null);
    const trimmed = note.trim();
    recall.mutate(trimmed ? { note: trimmed } : {}, {
      onSuccess: (dto) => {
        onOpenChange(false);
        toast.success(`${dto.claimNumber} recalled`, {
          description: `Revision ${dto.currentRevision} was withdrawn. Edit the claim and submit it again; approval restarts from level 1.`,
        });
      },
      onError: (e) => {
        if (e instanceof ApiError && MOVED_ON.has(e.code)) {
          const d = describeApiError(e);
          toast.error(d.title, { description: d.reference });
          onOpenChange(false);
          refresh();
          return;
        }
        setFailure(e); // CONFLICT, a refused note, network, 5xx: retry by hand (F2)
      },
    });
  };

  const failed = failure === null ? null : describeApiError(failure);
  const issues = failure instanceof ApiError ? (failure.details?.issues ?? []) : [];

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline">
          <Undo2 aria-hidden />
          Recall claim
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Recall {claim.claimNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            {approved.length > 0 ? (
              <>
                {names(approved)} {approved.length === 1 ? 'has' : 'have'} already approved{' '}
                {levels(approved)}. Recalling cancels the remaining approvals and voids{' '}
                {approved.length === 1 ? 'that approval' : 'those approvals'};
              </>
            ) : pending ? (
              <>
                No one has approved it yet. Recalling cancels the approval waiting with{' '}
                {pending.approver.name} (level {pending.level} of {steps.length});
              </>
            ) : (
              <>Recalling cancels the remaining approvals;</>
            )}{' '}
            when you resubmit, approval restarts from level 1 based on the new total.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <p className="text-sm">
          The claim goes back to a draft you can edit. Revision {claim.currentRevision} and its
          approvals stay in the history.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={noteId}>Note (optional)</Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={RECALL_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${noteId}-count`}
            placeholder="e.g. Wrong hotel invoice attached"
            rows={3}
          />
          <p id={`${noteId}-count`} className="text-muted-foreground text-right text-xs">
            {note.length} / {RECALL_NOTE_MAX}
          </p>
        </div>

        {failed && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle className="line-clamp-none">The claim was not recalled</AlertTitle>
            <AlertDescription>
              <p>{failed.title}</p>
              {issues.length > 0 && (
                <ul className="list-disc pl-4">
                  {issues.map((issue, i) => (
                    <li key={`${issue.path.join('.')}-${i}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
              <ErrorReference id={failed.requestId} />
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={recall.isPending}>Keep in approval</AlertDialogCancel>
          <Button type="button" onClick={confirm} disabled={recall.isPending}>
            {recall.isPending ? 'Recalling…' : 'Recall claim'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
