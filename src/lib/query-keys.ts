import type { UrlParams } from '@/lib/use-url-query';

/**
 * TanStack Query keys (05 §2.4). Every server-state read goes through one of these, so mutations
 * can invalidate by prefix: `['claims', 'mine']`, `['approvals']`, `['finance', 'claims']`.
 *
 * List keys carry the list's filter params exactly as `useUrlQuery` validated them from the URL
 * (the shared query schemas: ClaimListQuery, ApprovalQueueQuery, FinanceClaimsQuery), never
 * `cursor` or `limit`: the pages of one filter set live under one infinite-query key.
 */
export const qk = {
  categories: ['categories'] as const, // staleTime 1 h
  myClaimsAll: ['claims', 'mine'] as const,
  myClaims: (params: UrlParams) => ['claims', 'mine', params] as const,
  claim: (id: string) => ['claims', 'detail', id] as const,
  history: (id: string) => ['claims', 'history', id] as const,
  approvalsAll: ['approvals'] as const,
  approvals: (params: UrlParams) => ['approvals', params] as const,
  financeClaimsAll: ['finance', 'claims'] as const,
  financeClaims: (params: UrlParams) => ['finance', 'claims', params] as const,
};
