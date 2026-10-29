import {
  infiniteQueryOptions,
  keepPreviousData,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { apiFetch, one } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toSearch, type UrlParams } from '@/lib/use-url-query';
import { ApprovalTaskPage } from '@/shared/dto/approvals';
import { ClaimDetail } from '@/shared/dto/claims';
import type { ApproveInput, RejectInput } from '@/shared/schemas/claims';

/**
 * Approver data access (05 §2.4, §6.7, §10.2): the queue is a cursor-paged infinite query over
 * GET /api/v1/approvals; decisions POST with the `revision` the approver looked at and render the
 * server's ClaimDetail (no optimistic status, F2). Mutations never auto-retry.
 */

const ClaimDetailResponse = one(ClaimDetail);
const decisionPath = (claimId: string, action: 'approve' | 'reject') =>
  `/api/v1/claims/${encodeURIComponent(claimId)}/${action}` as const;

/**
 * GET /api/v1/approvals: my PENDING steps oldest-routed first (default), or my decided steps newest
 * first (`status=APPROVED,REJECTED`). `params` come from `useUrlQuery(ApprovalQueueQuery)`. Only
 * the server decides what is listed (TC-I25): the UI never filters rows.
 */
export const approvalsQuery = (params: UrlParams) =>
  infiniteQueryOptions({
    queryKey: qk.approvals(params),
    queryFn: ({ pageParam, signal }) => {
      const search = toSearch({ ...params, cursor: pageParam });
      return apiFetch(`/api/v1/approvals${search ? `?${search}` : ''}`, {
        schema: ApprovalTaskPage,
        signal,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData, // no flicker when switching tab or dates
  });

/** 05 §2.4 "Approve / reject": cache the fresh detail, refresh the queue and the history. */
function acceptDecision(qc: QueryClient, dto: ClaimDetail) {
  qc.setQueryData(qk.claim(dto.id), dto);
  void qc.invalidateQueries({ queryKey: qk.approvalsAll });
  void qc.invalidateQueries({ queryKey: qk.history(dto.id) });
}

/**
 * POST …/approve `{ revision, comment? }` → 200 ClaimDetail (the next level PENDING, or APPROVED).
 * NOT_IN_YOUR_QUEUE / ALREADY_DECIDED / REVISION_MISMATCH are handled by the decision panel.
 */
export function useApprove(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveInput) =>
      apiFetch(decisionPath(claimId, 'approve'), {
        method: 'POST',
        body: input,
        schema: ClaimDetailResponse,
      }),
    onSuccess: (dto) => acceptDecision(qc, dto),
    meta: { handlesErrors: true },
  });
}

/** POST …/reject `{ revision, reason }` → 200 ClaimDetail (REJECTED, waiting levels cancelled). */
export function useReject(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RejectInput) =>
      apiFetch(decisionPath(claimId, 'reject'), {
        method: 'POST',
        body: input,
        schema: ClaimDetailResponse,
      }),
    onSuccess: (dto) => acceptDecision(qc, dto),
    meta: { handlesErrors: true },
  });
}
