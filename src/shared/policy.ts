// C-14: policy constants shared by the forms, the API schemas and the tests, so all three cite one
// number. Isomorphic: no server imports. Business timezone and currency are code, never env (D-10).

export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const CURRENCY = 'INR';
export const MAX_LINE_ITEMS = 50;
export const MIN_LINE_AMOUNT_MINOR = 1;
export const MAX_LINE_AMOUNT_MINOR = 100_000_000; // ₹10,00,000.00
export const MAX_CLAIM_TOTAL_MINOR = 1_000_000_000; // ₹1,00,00,000.00
export const MIN_EXPENSE_DATE = '2000-01-01';
export const TITLE_LENGTH = { min: 3, max: 120 } as const;
export const DESCRIPTION_LENGTH = { min: 3, max: 500 } as const;
export const MERCHANT_MAX = 120;
export const REJECT_REASON_LENGTH = { min: 10, max: 1000 } as const;
export const APPROVE_COMMENT_MAX = 1000;
export const RECALL_NOTE_MAX = 500;
/** receipts_size_range allows 1..10485760 bytes: a lower limit is legal, a higher one is not. */
const RECEIPT_MAX_BYTES_CEILING = 10_485_760; // 10 MiB
/** A plain base-10 integer in 1..ceiling, else the ceiling: a bad value never breaks the build. */
function parseReceiptMaxBytes(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return RECEIPT_MAX_BYTES_CEILING;
  const bytes = Number(raw);
  return bytes <= RECEIPT_MAX_BYTES_CEILING ? bytes : RECEIPT_MAX_BYTES_CEILING;
}
// Vercel rejects request bodies over 4.5 MB (413), so that build sets this lower (next.config.ts).
// Read as a literal `process.env.NEXT_PUBLIC_*` so Next inlines it at build time into both the
// client and server bundles; `process.env[name]` would not be inlined.
export const RECEIPT_MAX_BYTES = parseReceiptMaxBytes(process.env.NEXT_PUBLIC_RECEIPT_MAX_BYTES);
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_RECEIPTS_PER_LINE = 5;
export const EXPORT_MAX_RANGE_DAYS = 366;
export const EXPORT_SETTLE_MINUTES = 2;
export const PAGE_LIMIT = { default: 25, max: 100 } as const;
/** Inbound x-request-id is kept only if it matches; claim_events.request_id is varchar(64). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** JSON request bodies above this are refused with 413 PAYLOAD_TOO_LARGE (04 §7.1). */
export const MAX_JSON_BODY_BYTES = 256 * 1024;
