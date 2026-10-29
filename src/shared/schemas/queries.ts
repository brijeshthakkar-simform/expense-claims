import { z } from 'zod';
import { inclusiveDays } from '@/shared/dates';
import { CLAIM_STATUSES } from '@/shared/enums';
import { EXPORT_MAX_RANGE_DAYS, PAGE_LIMIT } from '@/shared/policy';

// C-09 / 04 §8: list query strings. Strict like every request schema: an unknown param (including
// `sort`, which is fixed per endpoint) is 422 VALIDATION_FAILED. `from`/`to` are inclusive
// YYYY-MM-DD dates in Asia/Kolkata; the repository turns them into a half-open UTC range.

/** "A,B" → ['A', 'B'] (trimmed, de-duplicated), each value one of `values`. */
export const csvOf = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((s) => [...new Set(s.split(',').map((v) => v.trim()))])
    .pipe(z.array(z.enum(values)).min(1));

export const DateRange = {
  from: z.iso.date({ error: 'Use a real date in YYYY-MM-DD form' }).optional(),
  to: z.iso.date({ error: 'Use a real date in YYYY-MM-DD form' }).optional(),
};

export const Page = {
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT.max).default(PAGE_LIMIT.default),
};

export const fromBeforeTo = (q: { from?: string; to?: string }) =>
  !q.from || !q.to || q.from <= q.to;
const FROM_BEFORE_TO = { path: ['to'], error: '`to` must be on or after `from`' };

/** GET /api/v1/claims: my claims, newest first (`created_at DESC, id DESC`). */
export const ClaimListQuery = z
  .strictObject({
    status: csvOf(CLAIM_STATUSES).default([...CLAIM_STATUSES]),
    ...DateRange,
    ...Page,
  })
  .refine(fromBeforeTo, FROM_BEFORE_TO);
/** The parsed query (status always present, limit defaulted). */
export type ClaimListQuery = z.output<typeof ClaimListQuery>;
/** What a client may put in the URL. */
export type ClaimListQueryInput = z.input<typeof ClaimListQuery>;

/** The step statuses the approver queue can list (WAITING and CANCELLED never are). */
export const APPROVAL_QUEUE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ApprovalQueueStatus = (typeof APPROVAL_QUEUE_STATUSES)[number];
/** The Decided tab's value (`?status=APPROVED,REJECTED`). */
export const DECIDED_STATUSES = ['APPROVED', 'REJECTED'] as const;

/**
 * GET /api/v1/approvals: my steps. `status` = PENDING (default; `activated_at ASC, id ASC`, oldest
 * waiting first) or any of APPROVED, REJECTED (decided; `decided_at DESC, id DESC`). PENDING can't
 * be combined with a decided status (422). `from`/`to` (IST days) filter the tab's own date
 * column: activated_at ("routed to me between") or decided_at ("decided between").
 */
export const ApprovalQueueQuery = z
  .strictObject({
    status: csvOf(APPROVAL_QUEUE_STATUSES)
      .refine((s) => !s.includes('PENDING') || s.length === 1, {
        error: 'PENDING cannot be combined with APPROVED or REJECTED',
      })
      .default(['PENDING']),
    ...DateRange,
    ...Page,
  })
  .refine(fromBeforeTo, FROM_BEFORE_TO);
/** The parsed query (status always present, limit defaulted). */
export type ApprovalQueueQuery = z.output<typeof ApprovalQueueQuery>;
/** What a client may put in the URL. */
export type ApprovalQueueQueryInput = z.input<typeof ApprovalQueueQuery>;

/** The finance list's date column (`from`/`to` filter it, and it is the sort). */
export const FINANCE_DATE_FIELDS = ['submittedAt', 'approvedAt'] as const;
export type FinanceDateField = (typeof FINANCE_DATE_FIELDS)[number];
/** The finance list without `status`: everything except DRAFT (D-15, R-42). */
export const FINANCE_DEFAULT_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;

/**
 * GET /api/v1/finance/claims: every employee's claims, read-only, `<dateField> DESC, id DESC`.
 * `status` is any ClaimStatus list (default SUBMITTED,APPROVED,REJECTED: drafts only when asked
 * for). `dateField` (default submittedAt) picks the column `from`/`to` filter and the sort;
 * `approvedAt` lists only claims that have one (APPROVED).
 */
export const FinanceClaimsQuery = z
  .strictObject({
    status: csvOf(CLAIM_STATUSES).default([...FINANCE_DEFAULT_STATUSES]),
    dateField: z.enum(FINANCE_DATE_FIELDS).default('submittedAt'),
    ...DateRange,
    ...Page,
  })
  .refine(fromBeforeTo, FROM_BEFORE_TO);
/** The parsed query (status and dateField always present, limit defaulted). */
export type FinanceClaimsQuery = z.output<typeof FinanceClaimsQuery>;
/** What a client may put in the URL. */
export type FinanceClaimsQueryInput = z.input<typeof FinanceClaimsQuery>;

/** The only status the export accepts (§3.6: in-flight or rejected claims never leave the app). */
export const EXPORT_STATUS = 'APPROVED';

/**
 * GET /api/v1/finance/exports/approved-claims (D-32, 04 §10.6): `from`/`to` required inclusive IST
 * dates, `from ≤ to` (else 422 VALIDATION_FAILED), at most EXPORT_MAX_RANGE_DAYS (366) days
 * inclusive (else 422 EXPORT_RANGE_TOO_LARGE). `status` is optional and may only be APPROVED
 * (else 422 EXPORT_STATUS_NOT_ALLOWED): that is how the export "supports status filtering" without
 * ever leaking in-flight or rejected claims. The two refusals promote themselves to their own
 * codes through `params.code` (mapError).
 */
export const ExportQuery = z
  .strictObject({
    from: z.iso.date({ error: 'Use a real date in YYYY-MM-DD form' }),
    to: z.iso.date({ error: 'Use a real date in YYYY-MM-DD form' }),
    status: z.string().optional(),
  })
  .refine(fromBeforeTo, FROM_BEFORE_TO)
  .superRefine((q, ctx) => {
    if (q.status !== undefined && q.status !== EXPORT_STATUS)
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        params: { code: 'EXPORT_STATUS_NOT_ALLOWED' },
        message: 'Only APPROVED claims can be exported (requirements §3.6).',
      });
    // Refinements run even when a field failed: only a real, ordered range has a span.
    if (inclusiveDays(q.from, q.to) > EXPORT_MAX_RANGE_DAYS)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        params: { code: 'EXPORT_RANGE_TOO_LARGE' },
        message: `Export at most ${EXPORT_MAX_RANGE_DAYS} days at a time.`,
      });
  });
/** The parsed export query. */
export type ExportQuery = z.output<typeof ExportQuery>;
/** What a client may put in the URL (the export page only ever sends from and to). */
export type ExportQueryInput = z.input<typeof ExportQuery>;
