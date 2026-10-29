'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useMaybeMe } from '@/components/app-shell/actor-provider';
import { ErrorReference } from '@/components/common/error-reference';
import { DateTime } from '@/components/common/formatting';
import { NotFoundView } from '@/components/common/not-found-view';
import { QueryErrorView } from '@/components/common/query-error-view';
import { StatusBadge } from '@/components/common/status-badge';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  forgetClaim,
  useCategories,
  useClaim,
  useSaveClaim,
  useSubmitClaim,
} from '@/features/claims/api';
import { ApprovalChain } from '@/features/claims/approval-chain';
import { ClaimForm, type SaveOptions } from '@/features/claims/claim-form';
import { ClaimFormSkeleton } from '@/features/claims/claim-form-skeleton';
import { ClaimHistorySection } from '@/features/claims/claim-history';
import { ClaimStatusBanner } from '@/features/claims/claim-status-banner';
import { DeleteDraftDialog } from '@/features/claims/delete-draft-dialog';
import {
  LineReceipts,
  UnsavedLineReceipts,
  type ReceiptSlotProps,
} from '@/features/claims/receipts/line-receipts';
import { RecallDialog } from '@/features/claims/recall-dialog';
import { ApiError, describeApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { ReplaceClaimInput } from '@/shared/schemas/claims';

export type ClaimViewContext = 'owner' | 'approver' | 'finance';

const CRUMB: Record<ClaimViewContext, { href: string; label: string }> = {
  owner: { href: '/claims', label: 'My claims' },
  approver: { href: '/approvals', label: 'Approvals' },
  finance: { href: '/finance/claims', label: 'Finance claims' },
};

const isCode = (e: unknown, code: string): e is ApiError =>
  e instanceof ApiError && e.code === code;

/**
 * One claim screen for owner, approver and finance (05 §4.2). `context` changes only breadcrumbs,
 * chips and where the decision panel sits; which actions render is decided by the server's
 * allowedActions alone (F3).
 */
export function ClaimDetailView({
  claimId,
  context = 'owner',
  decision,
}: {
  claimId: string;
  context?: ClaimViewContext;
  /**
   * The approver's decision panel (features/approvals), rendered after the claim contents so the
   * lines are reviewed first. A slot rather than an import keeps claims independent of approvals.
   */
  decision?: (claim: ClaimDetail) => React.ReactNode;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMaybeMe();
  const [deleted, setDeleted] = useState(false);
  const claimQ = useClaim(claimId, !deleted);
  const claim = claimQ.data;
  const editable = claim?.allowedActions.includes('EDIT') ?? false;
  const categoriesQ = useCategories(editable);
  const save = useSaveClaim(claimId);
  const submit = useSubmitClaim(claimId);
  // Bumped to remount the form from the server's latest copy, dropping unsaved edits on purpose.
  const [formKey, setFormKey] = useState(0);
  const [staleError, setStaleError] = useState<ApiError | null>(null);
  const [recallOpen, setRecallOpen] = useState(false);
  // The claim moved on (decided, recalled elsewhere): drop a stale "open", so a later SUBMITTED
  // state never pops the dialog up by surprise.
  if (recallOpen && !(claim?.allowedActions.includes('RECALL') ?? false)) setRecallOpen(false);

  if (deleted) {
    return (
      <p role="status" className="text-muted-foreground py-16 text-center text-sm">
        Draft deleted. Returning to My claims…
      </p>
    );
  }
  // Same words whether the claim doesn't exist or isn't shared with this user (F9).
  if (isCode(claimQ.error, 'CLAIM_NOT_FOUND')) return <NotFoundView kind="claim" />;
  if (!claim) {
    if (claimQ.isError) {
      return (
        <QueryErrorView
          title="This claim couldn’t be loaded"
          error={claimQ.error}
          onRetry={() => void claimQ.refetch()}
        />
      );
    }
    return <ClaimFormSkeleton header />;
  }

  const onSave = async (payload: ReplaceClaimInput, opts?: SaveOptions): Promise<ClaimDetail> => {
    const dto = await save.mutateAsync(payload);
    if (!opts?.thenSubmit) toast.success('Draft saved');
    return dto;
  };

  // Caching the response (in the hook) re-renders this view from it: SUBMITTED, the new chain,
  // and allowedActions without EDIT, so the editor becomes the read-only table.
  const onSubmitClaim = async (): Promise<ClaimDetail> => {
    const dto = await submit.mutateAsync();
    const steps = dto.approval?.steps ?? [];
    const pending = steps.find((s) => s.status === 'PENDING');
    toast.success(
      dto.currentRevision > 1
        ? `${dto.claimNumber} resubmitted as revision ${dto.currentRevision}`
        : `${dto.claimNumber} submitted for approval`,
      {
        description: pending
          ? `Waiting for ${pending.approver.name} (level ${pending.level} of ${steps.length}).`
          : undefined,
      },
    );
    return dto;
  };

  /** The state moved on elsewhere: say so, then show what the server now allows. */
  const refetchWithToast = (e: ApiError) => {
    const d = describeApiError(e);
    void qc.invalidateQueries({ queryKey: qk.history(claimId) });
    if (e.code !== 'CLAIM_NOT_EDITABLE') {
      toast.error(d.title, { description: d.reference });
      void claimQ.refetch();
      return;
    }
    // In approval (another tab submitted it): offer Recall when the refetch says it's allowed.
    void claimQ.refetch().then(({ data }) => {
      const canRecall = data?.allowedActions.includes('RECALL') ?? false;
      toast.error(d.title, {
        description: d.reference,
        action: canRecall ? { label: 'Recall', onClick: () => setRecallOpen(true) } : undefined,
      });
    });
  };

  // Codes meaning the claim moved on elsewhere (05 §5.2), from a save or a receipt attach/remove.
  // Returns true when handled here; the form or the line's receipt list shows everything else.
  const onClaimMoved = (e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    if (e.code === 'LINE_ITEM_NOT_FOUND') {
      setStaleError(e); // a kept line was deleted elsewhere (another tab)
      return true;
    }
    if (e.code === 'CLAIM_NOT_EDITABLE' || e.code === 'CLAIM_LOCKED') {
      // Refetch: the new allowedActions lack EDIT, so the editor turns into the read-only table.
      refetchWithToast(e);
      return true;
    }
    if (e.code === 'CLAIM_NOT_FOUND') {
      void claimQ.refetch(); // deleted elsewhere: the refetch renders the not-found view
      return true;
    }
    return false;
  };

  // Codes this screen owns (05 §5.2); the form shows field issues and every other failure inline.
  const onSaveError = (e: unknown): boolean => {
    if (onClaimMoved(e)) return true;
    if (isCode(e, 'CATEGORY_INACTIVE')) void qc.invalidateQueries({ queryKey: qk.categories });
    return false;
  };

  // Receipts render from the server's lines (not form state), so unsaved edits are untouched.
  const renderReceipts = ({ lineItemId, n }: ReceiptSlotProps) =>
    lineItemId ? (
      <LineReceipts
        claimId={claim.id}
        lineItemId={lineItemId}
        n={n}
        receipts={claim.lineItems.find((li) => li.id === lineItemId)?.receipts ?? []}
        onClaimError={onClaimMoved}
      />
    ) : (
      <UnsavedLineReceipts n={n} hint="Save the claim to attach receipts to this line" />
    );

  // Submit codes (05 §5.2). NO_LINE_ITEMS, CATEGORY_INACTIVE and ROUTING_UNRESOLVABLE stay inline
  // in the form; a refused submit changed nothing, so the draft stays editable.
  const onSubmitError = (e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    if (
      e.code === 'INVALID_STATUS_TRANSITION' ||
      e.code === 'CLAIM_LOCKED' ||
      e.code === 'CLAIM_NOT_EDITABLE'
    ) {
      refetchWithToast(e); // e.g. already submitted from another tab
      return true;
    }
    if (e.code === 'CLAIM_NOT_FOUND') {
      void claimQ.refetch(); // deleted elsewhere: the refetch renders the not-found view
      return true;
    }
    // The row then shows "(retired)"; the form puts the error on it.
    if (e.code === 'CATEGORY_INACTIVE') void qc.invalidateQueries({ queryKey: qk.categories });
    // Lines removed in another tab: show the server's copy under the inline error.
    if (e.code === 'NO_LINE_ITEMS') void claimQ.refetch();
    return false;
  };

  const reload = async () => {
    await claimQ.refetch();
    setFormKey((k) => k + 1);
    setStaleError(null);
  };

  // Display only: a routed approver opening /claims/:id sees the claimant and no recall hints.
  const viewer: ClaimViewContext =
    context === 'owner' && me !== null && claim.claimant.id !== me.id ? 'approver' : context;

  const onDeleted = () => {
    setDeleted(true); // stop observing first, so removing the cache entry can't refetch a 404
    toast.success(`Draft ${claim.claimNumber} deleted`);
    router.replace('/claims');
    forgetClaim(qc, claimId);
  };

  return (
    <div className="flex flex-col gap-6">
      <ClaimHeader
        claim={claim}
        context={context}
        viewer={viewer}
        onDeleted={onDeleted}
        recallOpen={recallOpen}
        onRecallOpenChange={setRecallOpen}
      />
      <ClaimStatusBanner claim={claim} context={viewer} />

      <section aria-label="Claim contents" className="flex flex-col gap-4">
        {editable && categoriesQ.isError ? (
          <QueryErrorView
            level={2}
            title="Categories couldn’t be loaded"
            error={categoriesQ.error}
            onRetry={() => void categoriesQ.refetch()}
          />
        ) : editable && !categoriesQ.data ? (
          <ClaimFormSkeleton />
        ) : (
          <ClaimForm
            key={formKey}
            claim={claim}
            categories={categoriesQ.data ?? []}
            onSave={onSave}
            onSaveError={onSaveError}
            onSubmitClaim={onSubmitClaim}
            onSubmitError={onSubmitError}
            receipts={renderReceipts}
          />
        )}
      </section>

      {decision?.(claim)}

      {claim.approval && claim.approval.steps.length > 0 && (
        <ApprovalSection claim={claim} approval={claim.approval} />
      )}

      <ClaimHistorySection claim={claim} />

      <AlertDialog open={staleError !== null} onOpenChange={(o) => !o && setStaleError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This claim changed in another tab</AlertDialogTitle>
            <AlertDialogDescription>
              Reload to see the latest; your unsaved edits will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorReference id={staleError?.requestId} />
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button type="button" onClick={() => void reload()} disabled={claimQ.isFetching}>
              {claimQ.isFetching ? 'Reloading…' : 'Reload'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The current revision's chain (05 §9.2); earlier chains live in the history. */
function ApprovalSection({
  claim,
  approval,
}: {
  claim: ClaimDetail;
  approval: NonNullable<ClaimDetail['approval']>;
}) {
  const levels = approval.steps.length;
  // Display only: after a recall or rejection this chain is history, and a resubmit builds anew.
  const superseded = claim.status === 'DRAFT' || claim.status === 'REJECTED';
  return (
    <section aria-labelledby="approval-chain-heading" className="flex flex-col gap-3 border-t pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="approval-chain-heading" className="text-lg font-semibold">
          Approval chain
        </h2>
        <p className="text-muted-foreground text-sm">
          Revision {approval.revision} · {levels} approval level{levels === 1 ? '' : 's'}
        </p>
      </div>
      {superseded && (
        <p className="text-muted-foreground text-sm">
          This chain belongs to revision {approval.revision}. Resubmitting builds a new chain from
          level 1, based on the new total.
        </p>
      )}
      <ApprovalChain steps={approval.steps} />
    </section>
  );
}

function ClaimHeader({
  claim,
  context,
  viewer,
  onDeleted,
  recallOpen,
  onRecallOpenChange,
}: {
  claim: ClaimDetail;
  context: ClaimViewContext;
  /** `context`, except 'approver' when someone other than the claimant opens /claims/:id. */
  viewer: ClaimViewContext;
  onDeleted: () => void;
  recallOpen: boolean;
  onRecallOpenChange: (open: boolean) => void;
}) {
  const crumb = CRUMB[context];
  const steps = claim.approval?.steps ?? [];
  const pending = steps.find((s) => s.status === 'PENDING');
  return (
    <header className="flex flex-col gap-3">
      <nav aria-label="Breadcrumb">
        <ol className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
          <li>
            <Link
              href={crumb.href}
              className="hover:text-foreground underline-offset-4 hover:underline"
            >
              {crumb.label}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" data-testid="claim-number" className="text-foreground font-mono">
            {claim.claimNumber}
          </li>
        </ol>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold break-words">{claim.title}</h1>
          <p className="text-muted-foreground text-sm">
            {viewer !== 'owner' && <>Claimant: {claim.claimant.name} · </>}
            {claim.currentRevision > 0 && <>Revision {claim.currentRevision} · </>}
            {claim.submittedAt ? (
              <>
                Submitted <DateTime iso={claim.submittedAt} />
              </>
            ) : (
              <>
                Created <DateTime iso={claim.createdAt} />
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            data-testid="claim-status"
            status={claim.status}
            level={pending?.level}
            levelCount={steps.length || null}
          />
          {context === 'finance' && <Badge variant="secondary">Read-only (Finance)</Badge>}
          {/* A routed approver who opened the claim from elsewhere: decide on the review page. */}
          {context === 'owner' && claim.allowedActions.includes('APPROVE') && (
            <Button asChild variant="outline">
              <Link href={`/approvals/${claim.id}`}>
                <ClipboardCheck aria-hidden />
                Review in Approvals
              </Link>
            </Button>
          )}
          {claim.allowedActions.includes('RECALL') && (
            <RecallDialog claim={claim} open={recallOpen} onOpenChange={onRecallOpenChange} />
          )}
          {claim.allowedActions.includes('DELETE') && (
            <DeleteDraftDialog
              claimId={claim.id}
              claimNumber={claim.claimNumber}
              onDeleted={onDeleted}
            />
          )}
        </div>
      </div>
    </header>
  );
}
