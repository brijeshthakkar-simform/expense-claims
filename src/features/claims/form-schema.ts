import type { Path } from 'react-hook-form';
import { z } from 'zod';
import { todayInBusinessTz } from '@/shared/dates';
import type { ClaimDetail } from '@/shared/dto/claims';
import { formatMinor, parseMoneyToMinor, toDecimalString } from '@/shared/money';
import { MAX_CLAIM_TOTAL_MINOR, MAX_LINE_ITEMS } from '@/shared/policy';
import {
  AmountMinorSchema,
  CategoryIdSchema,
  CreateClaimInput,
  DescriptionSchema,
  ExpenseDateSchema,
  MerchantSchema,
  ReplaceClaimInput,
  TitleSchema,
} from '@/shared/schemas/claims';

/**
 * The form adapter (05 §6.2): the only client-specific schema. Every field rule is the shared one;
 * the adapter only turns what a person types ("1,250.50") into the wire's integer paise.
 */

export const MoneyStringSchema = z
  .string()
  .transform((raw, ctx) => {
    const r = parseMoneyToMinor(raw);
    if (!r.ok) {
      ctx.issues.push({ code: 'custom', message: r.message, input: raw });
      return z.NEVER;
    }
    return r.value;
  })
  .pipe(AmountMinorSchema); // the server's exact rule, re-applied

export const LineItemFormSchema = z.object({
  // RHF useFieldArray reserves `id` for its own row keys, so the server id travels as lineItemId.
  lineItemId: z.uuid().optional(),
  expenseDate: ExpenseDateSchema,
  categoryId: CategoryIdSchema,
  amount: MoneyStringSchema,
  description: DescriptionSchema,
  merchant: MerchantSchema,
});

const claimCapMessage = `Claim total cannot exceed ${formatMinor(MAX_CLAIM_TOTAL_MINOR)}`;

export const ClaimFormSchema = z.object({
  title: TitleSchema,
  lineItems: z
    .array(LineItemFormSchema)
    .max(MAX_LINE_ITEMS, `A claim can have at most ${MAX_LINE_ITEMS} line items`)
    .refine((ls) => ls.reduce((sum, l) => sum + l.amount, 0) <= MAX_CLAIM_TOTAL_MINOR, {
      message: claimCapMessage,
    }),
});

export type ClaimFormInput = z.input<typeof ClaimFormSchema>; // amount: string
export type ClaimFormOutput = z.output<typeof ClaimFormSchema>; // amount: number (paise)
export type LineItemFormInput = ClaimFormInput['lineItems'][number];

/**
 * Form values → the PUT body. There is no total field, so none can be sent; parsing with the
 * shared strict schema is belt and braces. The order of lines is the form's order, so server
 * issue paths (`lineItems.N.…`) index the same rows.
 */
export const toReplacePayload = (v: ClaimFormOutput): ReplaceClaimInput =>
  ReplaceClaimInput.parse({
    title: v.title,
    lineItems: v.lineItems.map(({ lineItemId, amount, merchant, ...rest }) => ({
      ...rest,
      ...(lineItemId && { id: lineItemId }),
      ...(merchant && { merchant }),
      amountMinor: amount,
    })),
  });

/** Create mode has no server ids yet, so the same payload is a valid POST body. */
export const toCreatePayload = (p: ReplaceClaimInput): CreateClaimInput =>
  CreateClaimInput.parse({
    title: p.title,
    lineItems: p.lineItems.map((l) => ({
      expenseDate: l.expenseDate,
      categoryId: l.categoryId,
      amountMinor: l.amountMinor,
      description: l.description,
      ...(l.merchant && { merchant: l.merchant }),
    })),
  });

export const toFormValues = (c: ClaimDetail): ClaimFormInput => ({
  title: c.title,
  lineItems: c.lineItems.map((li) => ({
    lineItemId: li.id,
    expenseDate: li.expenseDate,
    categoryId: li.category.id,
    amount: toDecimalString(li.amountMinor),
    description: li.description,
    merchant: li.merchant ?? '',
  })),
});

export const emptyLine = (): LineItemFormInput => ({
  expenseDate: todayInBusinessTz(),
  categoryId: '',
  amount: '',
  description: '',
  merchant: '',
});

export const emptyClaim = (): ClaimFormInput => ({ title: '', lineItems: [emptyLine()] });

const LINE_FIELDS = new Set(['expenseDate', 'categoryId', 'amount', 'description', 'merchant']);

/** A server issue path (`['lineItems', 1, 'amountMinor']`) → the form field it belongs to. */
export const claimPathMap = (p: (string | number)[]): Path<ClaimFormInput> | null => {
  const [a, i, f] = p;
  if (a === 'title' && p.length === 1) return 'title';
  if (a === 'lineItems' && typeof i === 'number') {
    const field = f === 'amountMinor' ? 'amount' : f;
    if (typeof field === 'string' && LINE_FIELDS.has(field)) {
      return `lineItems.${i}.${field}` as Path<ClaimFormInput>;
    }
  }
  return null;
};
