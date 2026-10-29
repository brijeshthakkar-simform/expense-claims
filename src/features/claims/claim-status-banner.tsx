import { Clock, Lock, RotateCcw, XCircle } from 'lucide-react';
import { DateTime } from '@/components/common/formatting';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { ClaimDetail } from '@/shared/dto/claims';

/**
 * Status banners (05 §7). Display only: keyed on status and revision, they never gate an action;
 * allowedActions does that, and the server re-decides every call.
 */
export function ClaimStatusBanner({
  claim,
  context = 'owner',
}: {
  claim: ClaimDetail;
  /** Recall/resubmit hints are for the claimant; approvers and finance see the state only. */
  context?: 'owner' | 'approver' | 'finance';
}) {
  const forOwner = context === 'owner';
  switch (claim.status) {
    case 'DRAFT':
      if (claim.currentRevision === 0) return null;
      return (
        <Alert data-testid="recalled-banner">
          <RotateCcw aria-hidden />
          <AlertTitle className="line-clamp-none">
            Recalled. Revision {claim.currentRevision} was withdrawn.
          </AlertTitle>
          {forOwner && (
            <AlertDescription>Edit and resubmit; approval restarts from level 1.</AlertDescription>
          )}
        </Alert>
      );
    case 'SUBMITTED': {
      const steps = claim.approval?.steps ?? [];
      const pending = steps.find((s) => s.status === 'PENDING');
      return (
        <Alert data-testid="in-approval-banner">
          <Clock aria-hidden />
          <AlertTitle className="line-clamp-none">
            {pending
              ? `In approval: waiting for ${pending.approver.name} (level ${pending.level} of ${steps.length}).`
              : 'In approval.'}
          </AlertTitle>
          {forOwner && <AlertDescription>To change anything, recall the claim.</AlertDescription>}
        </Alert>
      );
    }
    case 'REJECTED': {
      const r = claim.lastRejection;
      return (
        <Alert variant="destructive" data-testid="rejection-banner">
          <XCircle aria-hidden />
          <AlertTitle className="line-clamp-none">
            {r ? (
              <>
                Rejected by {r.by.name} · <DateTime iso={r.at} /> · revision {r.revision}, level{' '}
                {r.level}
              </>
            ) : (
              'Rejected'
            )}
          </AlertTitle>
          <AlertDescription>
            {/* Text only: React escapes it, so a reason can never inject markup. */}
            {r && (
              <blockquote className="border-l-2 pl-3 break-words italic">“{r.reason}”</blockquote>
            )}
            <p>
              {forOwner ? 'Edit the claim and resubmit. ' : 'The claimant can edit and resubmit. '}
              Approval restarts from level 1 using the new total; this reason stays in the history
              below.
            </p>
          </AlertDescription>
        </Alert>
      );
    }
    case 'APPROVED':
      return (
        <Alert data-testid="locked-banner">
          <Lock aria-hidden />
          <AlertTitle className="line-clamp-none">
            {claim.approvedAt ? (
              <>
                Approved on <DateTime iso={claim.approvedAt} />.
              </>
            ) : (
              'Approved.'
            )}{' '}
            This claim is locked.
          </AlertTitle>
          <AlertDescription>
            Line items, amounts and receipts can&apos;t be changed.
          </AlertDescription>
        </Alert>
      );
  }
}
