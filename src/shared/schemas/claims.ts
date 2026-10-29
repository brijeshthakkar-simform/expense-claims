import { z } from 'zod';
import { isValidYmd, todayInBusinessTz } from '@/shared/dates';
import {
  APPROVE_COMMENT_MAX,
  DESCRIPTION_LENGTH,
  MAX_CLAIM_TOTAL_MINOR,
  MAX_LINE_AMOUNT_MINOR,
  MAX_LINE_ITEMS,
  MERCHANT_MAX,
  MIN_EXPENSE_DATE,
  MIN_LINE_AMOUNT_MINOR,
  RECALL_NOTE_MAX,
  REJECT_REASON_LENGTH,
  TITLE_LENGTH,
} from '@/shared/policy';

// 04 §10 / D-28: request schemas, shared by the forms (zodResolver) and defineRoute. Every object
// is STRICT: an unknown key is refused, never stripped. A total-like key becomes 422
// TOTAL_IS_DERIVED and another server-owned key 422 READ_ONLY_FIELD (map-error.ts); everything else
// is 422 VALIDATION_FAILED with issues[].path. Rules that need the database (category exists and is
// active, claim status) run in the service under the claim lock. Zod 4 gotcha: compose shapes by
// spreading, then refine (.extend()/.omit() throw once an object has refinements).

// ------------------------------------------------------------------------------ field schemas

export const TitleSchema = z
  .string({ error: 'Enter a title' })
  .trim()
  .min(TITLE_LENGTH.min, { error: `Title must be at least ${TITLE_LENGTH.min} characters` })
  .max(TITLE_LENGTH.max, { error: `Title must be at most ${TITLE_LENGTH.max} characters` });

/** A real ISO calendar date, ≥ 2000-01-01 and not after today in IST ("today" read per parse). */
export const ExpenseDateSchema = z.iso
  .date({ error: 'Use a real date in YYYY-MM-DD form' })
  // Zod 4 still runs refinements after a failed format check; skip them for a non-date, or
  // '30/09/2026' would also be reported as "in the future" (string comparison).
  .refine((d) => !isValidYmd(d) || d >= MIN_EXPENSE_DATE, {
    error: `Expense date must be on or after ${MIN_EXPENSE_DATE}`,
  })
  .refine((d) => !isValidYmd(d) || d <= todayInBusinessTz(), {
    error: 'Expense date cannot be in the future (IST)',
  });

/** Integer paise, 1..100,000,000 (₹0.01 – ₹10,00,000.00). Floats and strings fail. */
export const AmountMinorSchema = z
  .int({ error: 'Amount must be a whole number of paise' })
  .min(MIN_LINE_AMOUNT_MINOR, { error: 'Amount must be greater than zero' })
  .max(MAX_LINE_AMOUNT_MINOR, { error: 'Amount cannot exceed ₹10,00,000.00 per line' });

export const CategoryIdSchema = z.uuid({ error: 'Choose a category' });

export const DescriptionSchema = z
  .string({ error: 'Enter a description' })
  .trim()
  .min(DESCRIPTION_LENGTH.min, {
    error: `Description must be at least ${DESCRIPTION_LENGTH.min} characters`,
  })
  .max(DESCRIPTION_LENGTH.max, {
    error: `Description must be at most ${DESCRIPTION_LENGTH.max} characters`,
  });

export const MerchantSchema = z
  .string()
  .trim()
  .max(MERCHANT_MAX, { error: `Merchant must be at most ${MERCHANT_MAX} characters` })
  .optional();

export const RejectReasonSchema = z
  .string({ error: 'Enter a reason' })
  .trim()
  .min(REJECT_REASON_LENGTH.min, {
    error: `Reason must be at least ${REJECT_REASON_LENGTH.min} characters`,
  })
  .max(REJECT_REASON_LENGTH.max, {
    error: `Reason must be at most ${REJECT_REASON_LENGTH.max} characters`,
  });

// ------------------------------------------------------------------------------- line items

const lineItemShape = {
  expenseDate: ExpenseDateSchema,
  categoryId: CategoryIdSchema,
  amountMinor: AmountMinorSchema,
  description: DescriptionSchema,
  merchant: MerchantSchema,
};

/** A line in a PUT replace-set: `id` present = keep/update that line, absent = insert a new one. */
export const LineItemInput = z.strictObject({ id: z.uuid().optional(), ...lineItemShape });
export type LineItemInput = z.infer<typeof LineItemInput>;

/** A line in a POST body: no `id` (an `id` key is 422 READ_ONLY_FIELD). */
export const NewLineItemInput = z.strictObject(lineItemShape);
export type NewLineItemInput = z.infer<typeof NewLineItemInput>;

const CLAIM_CAP_MESSAGE = 'Claim total cannot exceed ₹1,00,00,000.00';
const withinClaimCap = (ls: readonly { amountMinor: number }[]) =>
  ls.reduce((s, l) => s + l.amountMinor, 0) <= MAX_CLAIM_TOTAL_MINOR;
const uniqueIds = (ls: readonly { id?: string }[]) => {
  const ids = ls.flatMap((l) => (l.id ? [l.id] : []));
  return new Set(ids).size === ids.length;
};
const tooManyLines = { error: `A claim can have at most ${MAX_LINE_ITEMS} line items` };

// --------------------------------------------------------------------------- claim bodies

/** POST /api/v1/claims: a new DRAFT, optionally with its first lines. */
export const CreateClaimInput = z.strictObject({
  title: TitleSchema,
  lineItems: z
    .array(NewLineItemInput)
    .max(MAX_LINE_ITEMS, tooManyLines)
    .refine(withinClaimCap, { error: CLAIM_CAP_MESSAGE })
    .optional(),
});
export type CreateClaimInput = z.infer<typeof CreateClaimInput>;

/**
 * PUT /api/v1/claims/:claimId: the whole editable state (title + the complete line set). Lines with
 * an `id` are updated, lines without one inserted, and existing lines left out deleted. The total
 * is never accepted: Postgres derives it.
 */
export const ReplaceClaimInput = z.strictObject({
  title: TitleSchema,
  lineItems: z
    .array(LineItemInput)
    .max(MAX_LINE_ITEMS, tooManyLines)
    .refine(withinClaimCap, { error: CLAIM_CAP_MESSAGE })
    .refine(uniqueIds, { error: 'Each line item id may appear once' }),
});
export type ReplaceClaimInput = z.infer<typeof ReplaceClaimInput>;

// ----------------------------------------------------------------- workflow bodies (P3–P5)

/** POST …/submit: an optional, strictly empty body. */
export const SubmitInput = z.strictObject({});
export type SubmitInput = z.infer<typeof SubmitInput>;

export const RecallInput = z.strictObject({
  note: z
    .string()
    .trim()
    .max(RECALL_NOTE_MAX, { error: `Note must be at most ${RECALL_NOTE_MAX} characters` })
    .optional(),
});
export type RecallInput = z.infer<typeof RecallInput>;

export const ApproveInput = z.strictObject({
  revision: z.int().min(1),
  comment: z
    .string()
    .trim()
    .max(APPROVE_COMMENT_MAX, {
      error: `Comment must be at most ${APPROVE_COMMENT_MAX} characters`,
    })
    .optional(),
});
export type ApproveInput = z.infer<typeof ApproveInput>;

export const RejectInput = z.strictObject({ revision: z.int().min(1), reason: RejectReasonSchema });
export type RejectInput = z.infer<typeof RejectInput>;

// ----------------------------------------------------------------------------- path params

/** `[claimId]` routes. A malformed id is 404 CLAIM_NOT_FOUND (defineRoute), never 422. */
export const ClaimIdParams = z.strictObject({ claimId: z.uuid() });
export type ClaimIdParams = z.infer<typeof ClaimIdParams>;

/** `[claimId]/line-items/[lineItemId]` (receipt upload): a malformed line id is 404 LINE_ITEM_NOT_FOUND. */
export const LineItemReceiptsParams = z.strictObject({ claimId: z.uuid(), lineItemId: z.uuid() });
export type LineItemReceiptsParams = z.infer<typeof LineItemReceiptsParams>;

/** `[claimId]/receipts/[receiptId]` (download, delete): a malformed receipt id is 404 RECEIPT_NOT_FOUND. */
export const ReceiptParams = z.strictObject({ claimId: z.uuid(), receiptId: z.uuid() });
export type ReceiptParams = z.infer<typeof ReceiptParams>;
