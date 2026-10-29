'use client';

import { AlertCircle, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ErrorReference } from '@/components/common/error-reference';
import { Money } from '@/components/common/formatting';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApprove } from '@/features/approvals/api';
import { describeApiError } from '@/lib/api-client';
import type { ClaimDetail } from '@/shared/dto/claims';
import { APPROVE_COMMENT_MAX } from '@/shared/policy';

export interface ChainPosition {
  level: number;
  levelCount: number;
  /** Who gets the claim if this approval goes through; null at the final level. */
  nextApproverName: string | null;
}

/**
 * The approve confirmation (05 §6.7). It captures `revision` when it opens, so the approver signs
 * exactly what they looked at (a resubmission in between is 409 REVISION_MISMATCH), and it names
 * where the claim goes next, or says this is the final approval.
 */
export function ApproveDialog({
  claim,
  position,
  handleError,
}: {
  claim: ClaimDetail;
  /** Null only if the chain on screen has no PENDING step (it moved on): neutral copy then. */
  position: ChainPosition | null;
  /** The page's handler for codes that close the dialog; true = handled. */
  handleError: (e: unknown) => boolean;
}) {
  const router = useRouter();
  const approve = useApprove(claim.id);
  const commentId = useId();
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(claim.currentRevision);
  const [comment, setComment] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const final =
    position !== null &&
    position.nextApproverName === null &&
    position.level >= position.levelCount;

  const onOpenChange = (next: boolean) => {
    if (approve.isPending) return; // keep it open until the server answers
    if (next) {
      setRevision(claim.currentRevision); // sign what is on screen now
      setComment('');
      setFailure(null);
    }
    setOpen(next);
  };

  const confirm = () => {
    setFailure(null);
    const trimmed = comment.trim();
    approve.mutate(
      { revision, ...(trimmed && { comment: trimmed }) },
      {
        onSuccess: (dto) => {
          setOpen(false);
          const pending = dto.approval?.steps.find((s) => s.status === 'PENDING');
          toast.success(`${dto.claimNumber} approved`, {
            description:
              dto.status === 'APPROVED'
                ? 'Final approval recorded. The claim is locked and will be included in finance exports.'
                : pending
                  ? `It goes to ${pending.approver.name} next.`
                  : undefined,
          });
          router.push('/approvals');
        },
        onError: (e) => {
          if (handleError(e)) setOpen(false);
          else setFailure(e);
        },
      },
    );
  };

  const failed = failure === null ? null : describeApiError(failure);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">
          <Check aria-hidden />
          Approve
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {claim.claimNumber}?</DialogTitle>
          <DialogDescription>
            {position === null ? (
              <>Approve this claim at your level of its approval chain.</>
            ) : final ? (
              <>
                This is the final approval. The claim will be locked and included in finance
                exports.
              </>
            ) : (
              <>
                Level {position.level} of {position.levelCount}.{' '}
                {position.nextApproverName
                  ? `It will go to ${position.nextApproverName} next.`
                  : `It will go to level ${position.level + 1} next.`}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm">
          You are approving revision {revision}, total <Money minor={claim.totalMinor} />, for{' '}
          {claim.claimant.name}.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={commentId}>Comment (optional)</Label>
          <Textarea
            id={commentId}
            value={comment}
            maxLength={APPROVE_COMMENT_MAX}
            onChange={(e) => setComment(e.target.value)}
            aria-describedby={`${commentId}-count`}
            rows={3}
          />
          <p id={`${commentId}-count`} className="text-muted-foreground text-right text-xs">
            {comment.length} / {APPROVE_COMMENT_MAX}
          </p>
        </div>

        {failed && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle className="line-clamp-none">The approval didn’t go through</AlertTitle>
            <AlertDescription>
              <p>{failed.title}</p>
              <ErrorReference id={failed.requestId} />
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={approve.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={confirm} disabled={approve.isPending}>
            {approve.isPending ? 'Approving…' : 'Confirm approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
