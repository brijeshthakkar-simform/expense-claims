import { DateTime } from '@/components/common/formatting';
import { StepStatusChip } from '@/components/common/step-status-chip';
import { cn } from '@/lib/utils';
import type { ApprovalStepDto } from '@/shared/dto/claims';
import type { ApprovalStepStatus } from '@/shared/enums';

const MARKER: Record<ApprovalStepStatus, string> = {
  WAITING: 'border-dashed text-muted-foreground bg-background',
  PENDING: 'border-amber-400 bg-amber-100 text-amber-900',
  APPROVED: 'border-emerald-400 bg-emerald-100 text-emerald-900',
  REJECTED: 'border-destructive bg-destructive text-white',
  CANCELLED: 'text-muted-foreground bg-muted line-through',
};

/**
 * One revision's approval chain (05 §9.2): an ordered list, one item per level with the tier
 * label, approver, status chip, times in IST and any comment or reason. The PENDING step is the
 * current one (`aria-current="step"`, highlighted). Display only; it never gates an action.
 */
export function ApprovalChain({ steps }: { steps: readonly ApprovalStepDto[] }) {
  return (
    <ol aria-label="Approval chain" className="flex flex-col">
      {steps.map((step, i) => {
        const current = step.status === 'PENDING';
        const last = i === steps.length - 1;
        return (
          <li
            key={step.level}
            aria-current={current ? 'step' : undefined}
            data-testid="approval-step"
            data-status={step.status}
            className={cn('relative flex gap-3', !last && 'pb-3')}
          >
            {!last && (
              <span aria-hidden className="bg-border absolute top-9 bottom-0 left-4 w-px" />
            )}
            <span
              aria-hidden
              className={cn(
                'mt-1 flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums',
                MARKER[step.status],
              )}
            >
              {step.level}
            </span>
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-col gap-1 rounded-md border px-3 py-2',
                current ? 'border-amber-300 bg-amber-50/70 shadow-xs' : 'border-transparent',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium break-words">{step.approver.name}</span>
                <span className="text-muted-foreground text-sm">
                  Level {step.level} · {step.tierLabel}
                </span>
                <StepStatusChip status={step.status} />
              </div>
              <StepTiming step={step} previousLevel={i > 0 ? steps[i - 1]?.level : undefined} />
              {step.comment && (
                <p className="text-sm break-words">
                  <span className="text-muted-foreground">Comment: </span>
                  {step.comment}
                </p>
              )}
              {step.rejectionReason && (
                <blockquote className="border-destructive/40 border-l-2 pl-3 text-sm break-words italic">
                  “{step.rejectionReason}”
                </blockquote>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepTiming({ step, previousLevel }: { step: ApprovalStepDto; previousLevel?: number }) {
  const line = (label: string, iso: string) => (
    <p className="text-muted-foreground text-xs">
      {label} <DateTime iso={iso} />
    </p>
  );
  switch (step.status) {
    case 'WAITING':
      return (
        <p className="text-muted-foreground text-xs">
          {previousLevel ? `Starts after level ${previousLevel} approves` : 'Not started'}
        </p>
      );
    case 'PENDING':
      return step.activatedAt ? line('Waiting since', step.activatedAt) : null;
    case 'APPROVED':
      return step.decidedAt ? line('Approved', step.decidedAt) : null;
    case 'REJECTED':
      return step.decidedAt ? line('Rejected', step.decidedAt) : null;
    case 'CANCELLED':
      return step.decidedAt ? line('Cancelled', step.decidedAt) : null;
  }
}
