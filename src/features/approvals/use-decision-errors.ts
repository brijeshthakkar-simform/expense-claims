import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ApiError, describeApiError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';

/**
 * The decision codes the review page owns (05 §5.2). Each one means "the claim moved on while you
 * were looking": say so in a toast, refetch, and close the dialog. Returns false for everything else
 * (CONFLICT, VALIDATION_FAILED, network, 5xx), which the dialog shows inline so the approver can
 * retry by hand; a decision is never retried automatically (F2).
 */
export function useDecisionErrors(
  claimId: string,
  onRevisionMismatch: (currentRevision: number | null) => void,
) {
  const qc = useQueryClient();
  const router = useRouter();

  return (e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    const d = describeApiError(e);
    const refetchClaim = () => {
      void qc.invalidateQueries({ queryKey: qk.claim(claimId) });
      void qc.invalidateQueries({ queryKey: qk.history(claimId) });
    };
    const refreshQueue = () => qc.invalidateQueries({ queryKey: qk.approvalsAll });

    if (e.code === 'NOT_IN_YOUR_QUEUE') {
      // Recalled, decided by someone else, or never mine: back to a fresh queue. The detail is only
      // marked stale (no refetch while still on screen, which could flash "not found").
      toast.error(d.title, { description: d.reference });
      void refreshQueue();
      void qc.invalidateQueries({ queryKey: qk.claim(claimId), refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: qk.history(claimId), refetchType: 'none' });
      router.push('/approvals');
      return true;
    }
    if (e.code === 'REVISION_MISMATCH') {
      const current = e.details?.currentRevision;
      onRevisionMismatch(typeof current === 'number' ? current : null);
      toast.error(d.title, { description: d.reference });
      void refreshQueue();
      refetchClaim();
      return true;
    }
    if (e.code === 'ALREADY_DECIDED' || e.code === 'FORBIDDEN' || e.code === 'CLAIM_NOT_FOUND') {
      toast.error(d.title, { description: d.reference });
      void refreshQueue();
      refetchClaim();
      return true;
    }
    return false;
  };
}
