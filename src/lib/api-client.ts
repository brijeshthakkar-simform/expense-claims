import type { QueryClient } from '@tanstack/react-query';
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { z } from 'zod';
import { hardNavigate, loginHref } from '@/lib/navigation';
import { ErrorEnvelope, isErrorCode, type ApiIssue, type ErrorCode } from '@/shared/errors';

/**
 * The browser's only door to the data (05 §2.1, §5.1): same-origin fetch to /api/v1 with the session
 * cookie, JSON envelopes in and out, and every failure turned into one typed ApiError.
 */

export type { ApiIssue };

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';

export interface ApiErrorDetails {
  issues?: ApiIssue[];
  hint?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    /** HTTP status; 0 = the request never reached the server. */
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: ApiErrorDetails,
    /** Equals the response's x-request-id; support greps the logs for it. */
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** A missing/expired/revoked session, as opposed to a failed login (INVALID_CREDENTIALS). */
export const isUnauthenticated = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'UNAUTHENTICATED';

// ---------------------------------------------------------------------------------------------
// Envelopes (C-08)

/** `{ data: T }` → T */
export const one = <T extends z.ZodType>(schema: T): z.ZodType<z.output<T>> =>
  // The cast only helps TS through Zod's generic object type; the shape is validated at runtime.
  z.object({ data: schema }).transform((body) => (body as { data: z.output<T> }).data);

/** `{ data: T[], page: { nextCursor, limit } }` */
export const pageOf = <T extends z.ZodType>(schema: T) =>
  z.object({
    data: z.array(schema),
    page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
  });

export function toApiError(status: number, json: unknown, headerRequestId?: string): ApiError {
  const env = ErrorEnvelope.safeParse(json);
  if (!env.success) {
    return new ApiError(
      status,
      'UNEXPECTED_RESPONSE',
      `Unexpected ${status} from server`,
      undefined,
      headerRequestId,
    );
  }
  const { code, message, details, requestId } = env.data.error;
  if (isErrorCode(code)) return new ApiError(status, code, message, details, requestId);
  // A code this build doesn't know yet: keep the server's (user-safe) message and its code.
  return new ApiError(status, 'UNEXPECTED_RESPONSE', message, { serverCode: code }, requestId);
}

// ---------------------------------------------------------------------------------------------
// apiFetch

export type ApiPath = `/api/v1/${string}`;

export interface ApiFetchOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON-serialised; omit for a bodyless POST (logout, submit). */
  body?: unknown;
  signal?: AbortSignal;
  /** Shared DTO schema; unknown extra fields are stripped, enums are exact. */
  schema?: z.ZodType<T>;
}

export async function apiFetch<T = undefined>(
  path: ApiPath,
  opts: ApiFetchOptions<T> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
      headers: {
        accept: 'application/json',
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }

  const rid = res.headers.get('x-request-id') ?? undefined;
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, json, rid);
  if (!opts.schema) return json as T;
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      'UNEXPECTED_RESPONSE',
      'Server response did not match the expected shape',
      undefined,
      rid,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Global 401 handling (05 §2.3): wired into the QueryCache/MutationCache in <Providers>.

const onLoginPage = () => /^\/login(?:\/|$)/.test(window.location.pathname);

/** Full navigation to /login?next=<current page>, which also drops all in-memory state. */
export function redirectToLogin(): void {
  if (typeof window === 'undefined' || onLoginPage()) return;
  hardNavigate(loginHref(window.location.pathname + window.location.search));
}

/** The session is gone: forget every cached response, then send the user to sign in again. */
export function handleUnauthenticated(queryClient: QueryClient): void {
  queryClient.clear();
  redirectToLogin();
}

// ---------------------------------------------------------------------------------------------
// Error → UX copy (05 §5.2). Features with richer UX (dialogs, banners, field errors) handle their
// codes themselves; this is the generic toast / alert text and the fallback for everything else.

export interface ErrorDescription {
  title: string;
  /** "Reference: <requestId>", shown on every error surface. */
  reference?: string;
  requestId?: string;
}

type CopyFn = (e: ApiError) => string;
const REFUSED = 'The app sent a request the server refused';
const fromServer: CopyFn = (e) => e.message;

const COPY: Record<ClientErrorCode, string | CopyFn> = {
  MALFORMED_JSON: REFUSED,
  UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
  INVALID_CREDENTIALS: 'Email or password is incorrect',
  CSRF_REJECTED: REFUSED,
  FORBIDDEN: "You don't have permission to do that",
  NOT_IN_YOUR_QUEUE:
    'This claim is no longer waiting for you. It may have been recalled or decided.',
  CLAIM_NOT_FOUND: "Claim not found. It may not exist, or it isn't shared with you.",
  LINE_ITEM_NOT_FOUND:
    'This claim changed in another tab. Reload to see the latest; your unsaved edits will be lost.',
  RECEIPT_NOT_FOUND: 'That receipt is no longer attached to this claim.',
  ROUTE_NOT_FOUND: REFUSED,
  CLAIM_LOCKED: 'This claim is approved and locked.',
  CLAIM_NOT_EDITABLE: 'This claim is in approval. Recall it to make changes',
  INVALID_STATUS_TRANSITION: fromServer,
  ALREADY_DECIDED: 'You already decided this revision',
  REVISION_MISMATCH: (e) => {
    const n = e.details?.currentRevision;
    return `This claim was resubmitted${typeof n === 'number' ? ` as revision ${n}` : ''} while you were reviewing. Review the latest version before deciding.`;
  },
  CLAIM_HAS_HISTORY: "This claim was submitted before, so it can't be deleted",
  CONFLICT: 'Another change hit this claim at the same moment. Try again.',
  PAYLOAD_TOO_LARGE: fromServer,
  UNSUPPORTED_MEDIA_TYPE: REFUSED,
  VALIDATION_FAILED: fromServer,
  TOTAL_IS_DERIVED: REFUSED,
  READ_ONLY_FIELD: REFUSED,
  NO_LINE_ITEMS: 'Add at least one line item before submitting',
  CATEGORY_INACTIVE: 'A category on this claim has been retired. Choose another and save again',
  ROUTING_UNRESOLVABLE: (e) => {
    const level = e.details?.level;
    const where = typeof level === 'number' ? `approval level ${level}` : 'this claim';
    // Never says why (HR privacy): the reason stays in the server log.
    return `No eligible approver was found for ${where}. The claim was not submitted. Contact your administrator.`;
  },
  RECEIPT_TYPE_NOT_ALLOWED: fromServer,
  RECEIPT_LIMIT_REACHED: fromServer,
  INVALID_CURSOR: 'The list changed; showing the first page again',
  EXPORT_RANGE_TOO_LARGE: fromServer,
  EXPORT_STATUS_NOT_ALLOWED: fromServer,
  RATE_LIMITED: 'Too many attempts. Try again in a moment',
  INTERNAL_ERROR: 'Something went wrong',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Try again shortly.',
  NOT_READY: 'The service is temporarily unavailable. Try again shortly.',
  NETWORK_ERROR: 'You appear to be offline. Check your connection and try again.',
  UNEXPECTED_RESPONSE: (e) => (e.details?.serverCode ? e.message : 'Something went wrong'),
};

/** Codes no form of ours should ever trigger: logged in dev so the bug is visible. */
const UI_BUG_CODES = new Set<ClientErrorCode>([
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'TOTAL_IS_DERIVED',
  'READ_ONLY_FIELD',
  'CSRF_REJECTED',
  'ROUTE_NOT_FOUND',
]);

export function describeApiError(e: unknown): ErrorDescription {
  if (!(e instanceof ApiError)) return { title: 'Something went wrong' };
  if (UI_BUG_CODES.has(e.code) && process.env.NODE_ENV !== 'production') {
    console.error('The API refused a request this UI built:', e);
  }
  const copy = COPY[e.code];
  return {
    title: typeof copy === 'function' ? copy(e) : copy,
    reference: e.requestId ? `Reference: ${e.requestId}` : undefined,
    requestId: e.requestId,
  };
}

// ---------------------------------------------------------------------------------------------
// Server field issues → form fields (05 §5.3)

/**
 * Puts each VALIDATION_FAILED issue on its form field (focusing the first) and returns the ones
 * `mapPath` can't place, for a summary <Alert role="alert">.
 */
export function applyServerIssues<T extends FieldValues>(
  err: ApiError,
  setError: UseFormSetError<T>,
  mapPath: (path: (string | number)[]) => Path<T> | null,
): ApiIssue[] {
  const unmapped: ApiIssue[] = [];
  let first = true;
  for (const issue of err.details?.issues ?? []) {
    const name = mapPath(issue.path);
    if (name) {
      setError(name, { type: 'server', message: issue.message }, { shouldFocus: first });
      first = false;
    } else {
      unmapped.push(issue);
    }
  }
  return unmapped;
}
