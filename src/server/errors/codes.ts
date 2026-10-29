import 'server-only';
import { ERROR_CODES, isErrorCode, type ErrorCode } from '@/shared/errors';

export { ERROR_CODES, isErrorCode, type ErrorCode };

/**
 * C-06 / 04 §9.2: the one code → HTTP status table (plus default messages). The client-side code
 * list lives in src/shared/errors.ts; this table must cover exactly that list (typecheck fails
 * otherwise). 5xx messages are generic on purpose: the HTTP layer appends
 * "Quote reference <requestId>." and never sends details.
 */
export const ERROR_CATALOGUE = {
  MALFORMED_JSON: { status: 400, message: 'Request body is not valid JSON.' },
  UNAUTHENTICATED: { status: 401, message: 'Please sign in.' },
  INVALID_CREDENTIALS: { status: 401, message: 'Email or password is incorrect.' },
  CSRF_REJECTED: { status: 403, message: 'Cross-site request refused.' },
  FORBIDDEN: { status: 403, message: 'Your role does not allow this action.' },
  NOT_IN_YOUR_QUEUE: { status: 403, message: 'This claim is not awaiting your decision.' },
  CLAIM_NOT_FOUND: { status: 404, message: 'Claim not found.' },
  LINE_ITEM_NOT_FOUND: { status: 404, message: 'Line item not found on this claim.' },
  RECEIPT_NOT_FOUND: { status: 404, message: 'Receipt not found on this claim.' },
  ROUTE_NOT_FOUND: { status: 404, message: 'No such API route.' },
  CLAIM_LOCKED: { status: 409, message: 'This claim is approved and locked.' },
  CLAIM_NOT_EDITABLE: {
    status: 409,
    message: 'This claim is awaiting approval. Recall it to make changes.',
  },
  INVALID_STATUS_TRANSITION: {
    status: 409,
    message: "That action isn't possible in the claim's current status.",
  },
  ALREADY_DECIDED: { status: 409, message: 'You have already decided this claim.' },
  REVISION_MISMATCH: {
    status: 409,
    message: 'The claim changed since you opened it. Reload and review.',
  },
  CLAIM_HAS_HISTORY: { status: 409, message: "A claim that was submitted can't be deleted." },
  CONFLICT: { status: 409, message: 'The claim was changed by another request. Try again.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported content type.' },
  VALIDATION_FAILED: { status: 422, message: 'Some fields are invalid.' },
  TOTAL_IS_DERIVED: {
    status: 422,
    message: 'The claim total is calculated from its line items and cannot be set.',
  },
  READ_ONLY_FIELD: { status: 422, message: 'This field is set by the server.' },
  NO_LINE_ITEMS: { status: 422, message: 'Add at least one line item before submitting.' },
  CATEGORY_INACTIVE: { status: 422, message: 'This category is no longer available.' },
  ROUTING_UNRESOLVABLE: {
    status: 422,
    message: 'No eligible approver was found for this claim. Contact finance.',
  },
  RECEIPT_TYPE_NOT_ALLOWED: { status: 422, message: 'Upload a JPEG, PNG, WEBP or PDF.' },
  RECEIPT_LIMIT_REACHED: { status: 422, message: 'A line item can have at most 5 receipts.' },
  INVALID_CURSOR: { status: 422, message: 'This page link is no longer valid. Start again.' },
  EXPORT_RANGE_TOO_LARGE: { status: 422, message: 'Export at most 366 days at a time.' },
  EXPORT_STATUS_NOT_ALLOWED: {
    status: 422,
    message: 'Only APPROVED claims can be exported (requirements §3.6).',
  },
  RATE_LIMITED: { status: 429, message: 'Too many attempts. Try again later.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service temporarily unavailable.' },
  NOT_READY: { status: 503, message: 'Not ready.' },
} as const satisfies Record<ErrorCode, { status: number; message: string }>;

export const httpStatusOf = (code: ErrorCode): number => ERROR_CATALOGUE[code].status;
