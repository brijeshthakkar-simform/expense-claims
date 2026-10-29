import { z } from 'zod';

// C-21: the submission snapshot JSON v1, stored in claim_submissions.snapshot. The service builds
// it; claim_submissions_verify (UC016) proves it equals the live claim, lines and claimant before
// the row can exist, and the row is INSERT-only afterwards. Lines are in (expenseDate, id) order.

export const SnapshotReceiptV1 = z.object({
  receiptId: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  storageKey: z.string(),
});

export const SnapshotLineV1 = z.object({
  lineItemId: z.uuid(),
  expenseDate: z.iso.date(),
  categoryId: z.uuid(),
  categoryCode: z.string(),
  categoryName: z.string(),
  glCode: z.string(),
  amountMinor: z.number().int(),
  description: z.string(),
  merchant: z.string().nullable(),
  receipts: z.array(SnapshotReceiptV1),
});
export type SnapshotLineV1 = z.infer<typeof SnapshotLineV1>;

export const SnapshotV1 = z.object({
  v: z.literal(1),
  claimant: z.object({
    id: z.uuid(),
    employeeCode: z.string(),
    name: z.string(),
    email: z.string(),
    departmentCode: z.string(),
  }),
  title: z.string(),
  currency: z.string(),
  totalMinor: z.number().int(),
  lines: z.array(SnapshotLineV1),
});
export type SnapshotV1 = z.infer<typeof SnapshotV1>;
