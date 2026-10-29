'use client';

import { AlertCircle } from 'lucide-react';
import { ErrorReference } from '@/components/common/error-reference';
import { DateTime, Money } from '@/components/common/formatting';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useClaimHistory } from '@/features/claims/api';
import { LineItemsTable, type LineRow } from '@/features/claims/line-items-table';
import { describeApiError } from '@/lib/api-client';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ClaimHistory, ClaimHistoryEvent, ClaimHistorySubmission } from '@/shared/dto/history';
import type { ClaimEventType, EventActorRole, SubmissionOutcome } from '@/shared/enums';

const OUTCOME: Record<SubmissionOutcome, string> = {
  IN_APPROVAL: 'In approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RECALLED: 'Recalled',
};

const ROLE: Record<EventActorRole, string> = { CLAIMANT: 'claimant', APPROVER: 'approver' };

/** What the event's `reason` column holds, by type (02 §10.3). */
const REASON_LABEL: Record<ClaimEventType, string | null> = {
  CLAIM_SUBMITTED: null,
  CLAIM_RESUBMITTED: null,
  STEP_APPROVED: 'Comment',
  CLAIM_APPROVED: 'Comment',
  CLAIM_REJECTED: 'Reason',
  CLAIM_RECALLED: 'Note',
};

/**
 * History (05 §9.3, C-24 cut item 5 applied): the raw audit events from GET …/history, grouped by
 * revision oldest first, one `timeline-event` item per row with its type, actor, IST time, reason
 * and request id. Each revision keeps its frozen snapshot, so what every approver saw (and every
 * rejection reason) stays on screen after an edit and resubmit (§3.3). Display only.
 */
export function ClaimHistorySection({ claim }: { claim: ClaimDetail }) {
  // A never-submitted draft has no history by design (draft edits are not audited, 02 §10.6).
  const submitted = claim.currentRevision > 0;
  const historyQ = useClaimHistory(claim.id, submitted);

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3 border-t pt-6">
      <h2 id="history-heading" className="text-lg font-semibold">
        History
      </h2>
      {!submitted ? (
        <p className="text-muted-foreground text-sm">
          History starts when the claim is submitted. Each submission freezes a snapshot of its
          lines.
        </p>
      ) : historyQ.data ? (
        <RevisionGroups claimId={claim.id} history={historyQ.data} />
      ) : historyQ.isError ? (
        <HistoryError error={historyQ.error} onRetry={() => void historyQ.refetch()} />
      ) : (
        <div aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading history…</span>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
    </section>
  );
}

function HistoryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const d = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle className="line-clamp-none">The history couldn’t be loaded</AlertTitle>
      <AlertDescription>
        <p>{d.title}</p>
        <ErrorReference id={d.requestId} />
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function RevisionGroups({ claimId, history }: { claimId: string; history: ClaimHistory }) {
  const revisions = [
    ...new Set([
      ...history.submissions.map((s) => s.revision),
      ...history.events.map((e) => e.revision),
    ]),
  ].sort((a, b) => a - b);

  if (revisions.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing has been recorded yet.</p>;
  }
  return (
    <ol aria-label="History by revision" className="flex flex-col gap-4">
      {revisions.map((rev) => (
        <RevisionGroup
          key={rev}
          claimId={claimId}
          revision={rev}
          submission={history.submissions.find((s) => s.revision === rev)}
          events={history.events.filter((e) => e.revision === rev)}
        />
      ))}
    </ol>
  );
}

function RevisionGroup({
  claimId,
  revision,
  submission,
  events,
}: {
  claimId: string;
  revision: number;
  submission: ClaimHistorySubmission | undefined;
  events: ClaimHistoryEvent[];
}) {
  const headingId = `revision-${revision}-heading`;
  return (
    <li
      aria-labelledby={headingId}
      data-testid="revision-group"
      data-revision={revision}
      className="flex flex-col gap-2 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className="font-semibold">
          Revision {revision}
        </h3>
        {submission && (
          <>
            <span className="text-muted-foreground text-sm">
              · <Money minor={submission.totalMinor} /> · {submission.lineItemCount} line
              {submission.lineItemCount === 1 ? '' : 's'} · submitted{' '}
              <DateTime iso={submission.submittedAt} />
            </span>
            <Badge variant="outline" data-testid="revision-outcome">
              {OUTCOME[submission.outcome]}
            </Badge>
          </>
        )}
      </div>

      <ol aria-label={`Revision ${revision} events`} className="flex flex-col divide-y">
        {events.map((e) => (
          <EventItem key={e.id} event={e} />
        ))}
      </ol>

      {submission && (
        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer select-none">
            View submitted lines ({submission.snapshot.lines.length})
          </summary>
          <div className="mt-2">
            <LineItemsTable
              lines={submission.snapshot.lines.map(toRow)}
              caption={`Lines submitted in revision ${revision}`}
              claimId={claimId}
            />
          </div>
        </details>
      )}
    </li>
  );
}

/** One audit row, shown raw: the type as stored, who, when (IST), the reason, the request id. */
function EventItem({ event: e }: { event: ClaimHistoryEvent }) {
  const label = REASON_LABEL[e.type];
  const details = facts(e);
  return (
    <li
      data-testid="timeline-event"
      data-event-type={e.type}
      className="timeline-event flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className="font-mono text-xs font-semibold">{e.type}</code>
        <span className="text-sm">
          {e.actor.name} <span className="text-muted-foreground">({ROLE[e.actorRole]})</span>
        </span>
        <DateTime iso={e.occurredAt} className="text-muted-foreground text-xs" />
      </div>
      <p className="text-muted-foreground text-xs">
        {e.fromStatus} → {e.toStatus}
        {details.length > 0 && <> · {details.join(' · ')}</>}
      </p>
      {e.reason && (
        <div className="text-sm">
          {label && <span className="text-muted-foreground text-xs">{label}</span>}
          {/* Text only: React escapes it, so a reason can never inject markup. */}
          <blockquote className="border-l-2 pl-3 break-words italic">“{e.reason}”</blockquote>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Ref <code className="font-mono select-all">{e.requestId}</code>
      </p>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Payload facts. The payload is the type's C-20 JSON with ids, not names; read defensively so an
// older or newer shape shows fewer facts instead of breaking the page.

const num = (p: Record<string, unknown>, key: string): number | null => {
  const v = p[key];
  return typeof v === 'number' ? v : null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function facts(e: ClaimHistoryEvent): string[] {
  const p = e.payload;
  const out: string[] = [];
  const level = num(p, 'level');
  const levelCount = num(p, 'levelCount');
  if (level !== null)
    out.push(levelCount !== null ? `level ${level} of ${levelCount}` : `level ${level}`);
  if (Array.isArray(p.chain)) out.push(plural(p.chain.length, 'approval level', 'approval levels'));
  const prev = p.previousRevision;
  if (prev && typeof prev === 'object') {
    const { revision, outcome } = prev as Record<string, unknown>;
    if (typeof revision === 'number' && typeof outcome === 'string') {
      out.push(`after revision ${revision} was ${outcome.toLowerCase()}`);
    }
  }
  const voided = num(p, 'approvedLevelsVoided');
  if (voided !== null) out.push(plural(voided, 'approval voided', 'approvals voided'));
  if (Array.isArray(p.cancelledSteps)) {
    out.push(plural(p.cancelledSteps.length, 'step cancelled', 'steps cancelled'));
  } else if (Array.isArray(p.cancelledStepIds) && p.cancelledStepIds.length > 0) {
    out.push(plural(p.cancelledStepIds.length, 'later step cancelled', 'later steps cancelled'));
  }
  return out;
}

const toRow = (l: ClaimHistorySubmission['snapshot']['lines'][number]): LineRow => ({
  id: l.lineItemId,
  expenseDate: l.expenseDate,
  amountMinor: l.amountMinor,
  description: l.description,
  merchant: l.merchant,
  category: { name: l.categoryName },
  // Evidence as submitted: still downloadable after the line or receipt is gone (D-31).
  receipts: l.receipts.map(({ receiptId, fileName, contentType, sizeBytes }) => ({
    id: receiptId,
    fileName,
    contentType,
    sizeBytes,
  })),
});
