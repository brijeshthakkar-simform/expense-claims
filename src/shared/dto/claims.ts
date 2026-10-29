import { z } from 'zod';
import { CategoryDto } from '@/shared/dto/categories';
import { ApprovalStepStatus, ClaimAction, ClaimStatus } from '@/shared/enums';

// C-10 / 04 §7.3 response shapes. The client parses every response with these (extra fields are
// stripped, enums are exact), so contract drift fails loudly. Wire formats: instants are UTC ISO
// with Z, calendar dates YYYY-MM-DD, money integer paise. `totalMinor` is always the DB value.

const Instant = z.iso.datetime();
const Ymd = z.iso.date();
const Minor = z.number().int();

export const UserRef = z.object({ id: z.uuid(), name: z.string(), email: z.string().optional() });
export type UserRef = z.infer<typeof UserRef>;

export const ReceiptDto = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: Instant,
});
export type ReceiptDto = z.infer<typeof ReceiptDto>;

export const LineItemDto = z.object({
  id: z.uuid(),
  expenseDate: Ymd,
  category: CategoryDto,
  amountMinor: Minor,
  description: z.string(),
  merchant: z.string().nullable(),
  receipts: z.array(ReceiptDto),
});
export type LineItemDto = z.infer<typeof LineItemDto>;

export const ApprovalStepDto = z.object({
  level: z.number().int(),
  tierCode: z.string(),
  tierLabel: z.string(),
  approver: UserRef,
  status: ApprovalStepStatus,
  activatedAt: Instant.nullable(),
  decidedAt: Instant.nullable(),
  comment: z.string().nullable(),
  rejectionReason: z.string().nullable(),
});
export type ApprovalStepDto = z.infer<typeof ApprovalStepDto>;

/**
 * The newest REJECTED step of any revision (02 §7.1): who rejected which revision at which level,
 * why and when. Kept after a resubmit as "previously rejected" context; the claimant's banner
 * shows it only while the claim is REJECTED.
 */
export const LastRejection = z.object({
  revision: z.number().int(),
  level: z.number().int(),
  reason: z.string(),
  by: UserRef,
  at: Instant,
});
export type LastRejection = z.infer<typeof LastRejection>;

/** GET/POST/PUT claim responses. `approval` arrives with P3, `lastRejection` with P5. */
export const ClaimDetail = z.object({
  id: z.uuid(),
  claimNumber: z.string(),
  title: z.string(),
  status: ClaimStatus,
  currency: z.string(),
  totalMinor: Minor,
  currentRevision: z.number().int(),
  claimant: UserRef,
  createdAt: Instant,
  submittedAt: Instant.nullable(),
  approvedAt: Instant.nullable(),
  rejectedAt: Instant.nullable(),
  lineItems: z.array(LineItemDto),
  approval: z.object({ revision: z.number().int(), steps: z.array(ApprovalStepDto) }).nullable(),
  lastRejection: LastRejection.nullable(),
  /** From the server's decide(); the UI renders buttons from this list only (D-50). */
  allowedActions: z.array(ClaimAction),
});
export type ClaimDetail = z.infer<typeof ClaimDetail>;

/** List rows (GET /claims; later the finance list, which adds `claimant`). */
export const ClaimSummary = z.object({
  id: z.uuid(),
  claimNumber: z.string(),
  title: z.string(),
  status: ClaimStatus,
  currency: z.string(),
  totalMinor: Minor,
  currentRevision: z.number().int(),
  lineItemCount: z.number().int(),
  claimant: UserRef.optional(),
  createdAt: Instant,
  submittedAt: Instant.nullable(),
  approvedAt: Instant.nullable(),
  currentLevel: z.number().int().optional(),
  levelCount: z.number().int().optional(),
});
export type ClaimSummary = z.infer<typeof ClaimSummary>;

/** The C-08 list envelope's `page` block. */
export const PageInfo = z.object({ nextCursor: z.string().nullable(), limit: z.number().int() });
export type PageInfo = z.infer<typeof PageInfo>;

/** `GET /api/v1/claims` body: `{ data: ClaimSummary[], page }`. */
export const ClaimSummaryPage = z.object({ data: z.array(ClaimSummary), page: PageInfo });
export type ClaimSummaryPage = z.infer<typeof ClaimSummaryPage>;
