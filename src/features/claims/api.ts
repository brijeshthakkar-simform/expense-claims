import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, one } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { toSearch, type UrlParams } from '@/lib/use-url-query';
import { receiptPath, uploadReceipt } from '@/features/claims/receipts/upload';
import { CategoryDto } from '@/shared/dto/categories';
import { ClaimDetail, ClaimSummaryPage, type ReceiptDto } from '@/shared/dto/claims';
import { ClaimHistory } from '@/shared/dto/history';
import type { CreateClaimInput, RecallInput, ReplaceClaimInput } from '@/shared/schemas/claims';

/**
 * Claims data access for the browser (05 §2.4, §6.7): every read and write goes through /api/v1,
 * every response is parsed with the shared DTO schemas, and mutations render the server's
 * ClaimDetail (no optimistic money or status, F2).
 */

const CATEGORIES_STALE_MS = 60 * 60 * 1000; // categories change by owner script only

const ClaimDetailResponse = one(ClaimDetail);
const CategoriesResponse = one(z.array(CategoryDto));
const ClaimHistoryResponse = one(ClaimHistory);

const claimPath = (claimId: string) => `/api/v1/claims/${encodeURIComponent(claimId)}` as const;

// ---------------------------------------------------------------------------------------------
// Queries

export const categoriesQuery = () =>
  queryOptions({
    queryKey: qk.categories,
    queryFn: ({ signal }) => apiFetch('/api/v1/categories', { schema: CategoriesResponse, signal }),
    staleTime: CATEGORIES_STALE_MS,
  });

export const claimQuery = (claimId: string) =>
  queryOptions({
    queryKey: qk.claim(claimId),
    queryFn: ({ signal }) => apiFetch(claimPath(claimId), { schema: ClaimDetailResponse, signal }),
  });

/**
 * GET /api/v1/claims/:claimId/history (05 §9): every revision's snapshot, outcome and chain, plus
 * the audit events oldest first. Same visibility as the claim itself; bounded, so no paging.
 */
export const claimHistoryQuery = (claimId: string) =>
  queryOptions({
    queryKey: qk.history(claimId),
    queryFn: ({ signal }) =>
      apiFetch(`${claimPath(claimId)}/history`, { schema: ClaimHistoryResponse, signal }),
  });

/**
 * GET /api/v1/claims: my claims, newest first, one cursor page per "Load more" (05 §10.2). `params`
 * are the URL's filter params, already validated by `useUrlQuery(ClaimListQuery)`.
 */
export const myClaimsQuery = (params: UrlParams) =>
  infiniteQueryOptions({
    queryKey: qk.myClaims(params),
    queryFn: ({ pageParam, signal }) => {
      const search = toSearch({ ...params, cursor: pageParam });
      return apiFetch(`/api/v1/claims${search ? `?${search}` : ''}`, {
        schema: ClaimSummaryPage,
        signal,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData, // no flicker while a new filter loads
  });

export const useCategories = (enabled = true) => useQuery({ ...categoriesQuery(), enabled });
export const useClaim = (claimId: string, enabled = true) =>
  useQuery({ ...claimQuery(claimId), enabled });
export const useClaimHistory = (claimId: string, enabled = true) =>
  useQuery({ ...claimHistoryQuery(claimId), enabled });

// ---------------------------------------------------------------------------------------------
// Mutations

/** Puts a fresh server DTO on screen everywhere it is shown. */
function acceptClaim(qc: QueryClient, dto: ClaimDetail) {
  qc.setQueryData(qk.claim(dto.id), dto);
  void qc.invalidateQueries({ queryKey: qk.myClaimsAll });
}

/** POST /api/v1/claims → 201 ClaimDetail. The form renders its own errors. */
export function useCreateClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClaimInput) =>
      apiFetch('/api/v1/claims', { method: 'POST', body: input, schema: ClaimDetailResponse }),
    onSuccess: (dto) => acceptClaim(qc, dto),
    meta: { handlesErrors: true },
  });
}

/** PUT /api/v1/claims/:claimId: the whole replace-set in one transaction (D-27). */
export function useSaveClaim(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplaceClaimInput) =>
      apiFetch(claimPath(claimId), { method: 'PUT', body: input, schema: ClaimDetailResponse }),
    onSuccess: (dto) => acceptClaim(qc, dto),
    meta: { handlesErrors: true }, // field issues, the reload dialog and refetches live in the view
  });
}

/**
 * POST /api/v1/claims/:claimId/submit (bodyless) → 200 ClaimDetail: SUBMITTED, revision + 1, the
 * fresh chain and allowedActions without EDIT, so caching it turns the editor read-only (05 §2.4).
 * NO_LINE_ITEMS, CATEGORY_INACTIVE and ROUTING_UNRESOLVABLE render inline in the form.
 */
export function useSubmitClaim(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`${claimPath(claimId)}/submit`, { method: 'POST', schema: ClaimDetailResponse }),
    onSuccess: (dto) => {
      acceptClaim(qc, dto);
      void qc.invalidateQueries({ queryKey: qk.history(dto.id) });
    },
    meta: { handlesErrors: true },
  });
}

/**
 * POST /api/v1/claims/:claimId/recall `RecallInput` → 200 ClaimDetail: DRAFT again (revision kept),
 * open steps CANCELLED, editable. The recall dialog owns its errors: a 409 (decided or recalled
 * meanwhile) closes it and refetches; anything else stays inline for a manual retry (F2).
 */
export function useRecallClaim(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecallInput) =>
      apiFetch(`${claimPath(claimId)}/recall`, {
        method: 'POST',
        body: input,
        schema: ClaimDetailResponse,
      }),
    onSuccess: (dto) => {
      acceptClaim(qc, dto);
      void qc.invalidateQueries({ queryKey: qk.history(dto.id) });
    },
    meta: { handlesErrors: true },
  });
}

/**
 * DELETE /api/v1/claims/:claimId → 204. The caller stops observing the claim, navigates away and
 * then drops it with `forgetClaim` (removing it while observed would refetch into a 404 flash).
 * Errors use the global toast, then the view refetches to show what the server now says.
 */
export function useDeleteDraft(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(claimPath(claimId), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.myClaimsAll }),
    // CLAIM_HAS_HISTORY / CLAIM_LOCKED / CLAIM_NOT_FOUND
    onError: () => qc.invalidateQueries({ queryKey: qk.claim(claimId) }),
  });
}

export const forgetClaim = (qc: QueryClient, claimId: string) =>
  qc.removeQueries({ queryKey: qk.claim(claimId) });

// ---------------------------------------------------------------------------------------------
// Receipts (05 §8). Each change is applied to the cached claim from the server's answer (never
// optimistically), then the claim is refetched so totals, order and allowedActions are the server's.

type LineReceiptsUpdate = (receipts: ReceiptDto[], lineItemId: string) => ReceiptDto[];

function updateCachedReceipts(qc: QueryClient, claimId: string, update: LineReceiptsUpdate) {
  qc.setQueryData<ClaimDetail>(qk.claim(claimId), (claim) =>
    claim
      ? {
          ...claim,
          lineItems: claim.lineItems.map((li) => ({ ...li, receipts: update(li.receipts, li.id) })),
        }
      : claim,
  );
  void qc.invalidateQueries({ queryKey: qk.claim(claimId) });
}

export interface UploadReceiptInput {
  lineItemId: string;
  file: File;
}

/**
 * POST …/line-items/:lineItemId/receipts (multipart) → 201 ReceiptDto. The line's receipt list
 * renders every error itself (413/422 inline; the 409s through the screen's refetch + toast).
 */
export function useUploadReceipt(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineItemId, file }: UploadReceiptInput) =>
      uploadReceipt(claimId, lineItemId, file),
    onSuccess: (receipt, { lineItemId }) =>
      updateCachedReceipts(qc, claimId, (receipts, id) =>
        id === lineItemId ? [...receipts.filter((r) => r.id !== receipt.id), receipt] : receipts,
      ),
    meta: { handlesErrors: true },
  });
}

/** DELETE …/receipts/:receiptId → 204. RECEIPT_NOT_FOUND (gone already) refetches the claim. */
export function useDeleteReceipt(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: string) =>
      apiFetch(receiptPath(claimId, receiptId), { method: 'DELETE' }),
    onSuccess: (_none, receiptId) =>
      updateCachedReceipts(qc, claimId, (receipts) => receipts.filter((r) => r.id !== receiptId)),
    meta: { handlesErrors: true },
  });
}
