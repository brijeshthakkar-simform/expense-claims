import { z } from 'zod';

/**
 * C-06: every API error code, isomorphic. The UI switches on `error.code`, never on message text.
 * The server maps each code to its HTTP status in src/server/errors/codes.ts, which is typed
 * against this list, so a code added on one side only fails typecheck.
 */
export const ERROR_CODES = [
  'MALFORMED_JSON',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'NOT_IN_YOUR_QUEUE',
  'CLAIM_NOT_FOUND',
  'LINE_ITEM_NOT_FOUND',
  'RECEIPT_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'CLAIM_LOCKED',
  'CLAIM_NOT_EDITABLE',
  'INVALID_STATUS_TRANSITION',
  'ALREADY_DECIDED',
  'REVISION_MISMATCH',
  'CLAIM_HAS_HISTORY',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_FAILED',
  'TOTAL_IS_DERIVED',
  'READ_ONLY_FIELD',
  'NO_LINE_ITEMS',
  'CATEGORY_INACTIVE',
  'ROUTING_UNRESOLVABLE',
  'RECEIPT_TYPE_NOT_ALLOWED',
  'RECEIPT_LIMIT_REACHED',
  'INVALID_CURSOR',
  'EXPORT_RANGE_TOO_LARGE',
  'EXPORT_STATUS_NOT_ALLOWED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'NOT_READY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && CODE_SET.has(value);

/** One field-level problem; `path` is an array so a form can map it onto the exact field. */
export const ApiIssue = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string(),
});
export type ApiIssue = z.infer<typeof ApiIssue>;

/**
 * C-08 error envelope. `code` stays a plain string so a code the client doesn't know yet still
 * parses (the UI then shows the server's message); `details` appears on 4xx only.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .looseObject({ issues: z.array(ApiIssue).optional(), hint: z.string().optional() })
      .optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
