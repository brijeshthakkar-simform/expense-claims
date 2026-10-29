'use client';

import { CircleCheck, Info } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '@/components/app-shell/actor-provider';
import { DateTime } from '@/components/common/formatting';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApproveDialog, type ChainPosition } from '@/features/approvals/approve-dialog';
import { RejectDialog } from '@/features/approvals/reject-dialog';
import { useDecisionErrors } from '@/features/approvals/use-decision-errors';
import type { ApprovalStepDto, ClaimDetail } from '@/shared/dto/claims';

/**
 * Approve / Reject on /approvals/[claimId] (05 §7). The buttons render from the server's
 * allowedActions only (F3); the chain is read just for the copy (level, who is next). The server
 * re-decides every call: role gate → PENDING-scoped lock → revision.
 */
export function DecisionPanel({ claim }: { claim: ClaimDetail }) {
  const me = useMe();
  const [mismatch, setMismatch] = useState<{ revision: number | null } | null>(null);
  const handleError = useDecisionErrors(claim.id, (revision) => setMismatch({ revision }));

  const canApprove = claim.allowedActions.includes('APPROVE');
  const canReject = claim.allowedActions.includes('REJECT');
  const steps = claim.approval?.steps ?? [];

  const notice = mismatch && (
    <Alert>
      <Info aria-hidden />
      <AlertTitle className="line-clamp-none">
        This claim was resubmitted
        {mismatch.revision !== null && ` as revision ${mismatch.revision}`} while you were
        reviewing.
      </AlertTitle>
      <AlertDescription>Review the latest version before deciding.</AlertDescription>
    </Alert>
  );

  if (!canApprove && !canReject) {
    return (
      <section aria-labelledby="decision-heading" className="flex flex-col gap-3">
        <h2 id="decision-heading" className="sr-only">
          Your decision
        </h2>
        {notice}
        <NothingToDecide steps={steps} meId={me.id} />
      </section>
    );
  }

  const mine =
    steps.find((s) => s.status === 'PENDING' && s.approver.id === me.id) ??
    steps.find((s) => s.status === 'PENDING');
  const position: ChainPosition | null = mine
    ? {
        level: mine.level,
        levelCount: steps.length,
        nextApproverName: steps.find((s) => s.level === mine.level + 1)?.approver.name ?? null,
      }
    : null;

  return (
    <section
      aria-labelledby="decision-heading"
      data-testid="decision-panel"
      className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="decision-heading" className="text-lg font-semibold">
          Your decision
        </h2>
        {position && (
          <p className="text-muted-foreground text-sm">
            Level {position.level} of {position.levelCount}
            {mine && ` · ${mine.tierLabel}`}.{' '}
            {position.nextApproverName
              ? `If you approve, it goes to ${position.nextApproverName} next.`
              : 'Yours is the final approval.'}
          </p>
        )}
      </div>
      {notice}
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <ApproveDialog claim={claim} position={position} handleError={handleError} />
        )}
        {canReject && <RejectDialog claim={claim} handleError={handleError} />}
      </div>
    </section>
  );
}

/** Opened from the Decided tab, or the claim moved on: say what my part was, if any. */
function NothingToDecide({ steps, meId }: { steps: readonly ApprovalStepDto[]; meId: string }) {
  const decided = steps.find(
    (s) => s.approver.id === meId && (s.status === 'APPROVED' || s.status === 'REJECTED'),
  );
  return (
    <p
      role="note"
      className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm"
    >
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      {decided?.decidedAt ? (
        <span>
          You {decided.status === 'APPROVED' ? 'approved' : 'rejected'} this claim at level{' '}
          {decided.level} on <DateTime iso={decided.decidedAt} />. Nothing else is waiting for you.
        </span>
      ) : (
        <span>This claim isn&apos;t waiting for your decision.</span>
      )}
    </p>
  );
}
