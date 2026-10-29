import {
  ApiError,
  describeApiError,
  one,
  toApiError,
  type ClientErrorCode,
} from '@/lib/api-client';
import { ReceiptDto } from '@/shared/dto/claims';
import { MAX_RECEIPTS_PER_LINE, RECEIPT_MAX_BYTES, RECEIPT_TYPES } from '@/shared/policy';

/**
 * Receipt transport and copy (05 §8). Core is a server-proxied multipart POST through fetch: no
 * progress bar (C-24 cut item 4), so an upload shows a disabled Attach with "Uploading…".
 */

const ReceiptResponse = one(ReceiptDto);

const claimPath = (claimId: string) => `/api/v1/claims/${encodeURIComponent(claimId)}` as const;

/** The `accept` list for the file input: the same allowlist the server enforces. */
export const RECEIPT_ACCEPT = RECEIPT_TYPES.join(',');

/** GET …/receipts/:receiptId/content: streamed after the visibility check, as an attachment. */
export const receiptContentHref = (claimId: string, receiptId: string) =>
  `${claimPath(claimId)}/receipts/${encodeURIComponent(receiptId)}/content`;

export const receiptPath = (claimId: string, receiptId: string) =>
  `${claimPath(claimId)}/receipts/${encodeURIComponent(receiptId)}` as const;

/**
 * POST /api/v1/claims/:claimId/line-items/:lineItemId/receipts, multipart with the single field
 * `file` → 201 `{ data: ReceiptDto }`. The browser sets the multipart boundary, so no content-type
 * header here. Failures become the same ApiError as apiFetch's, error envelope and request id kept.
 */
export async function uploadReceipt(
  claimId: string,
  lineItemId: string,
  file: File,
  signal?: AbortSignal,
): Promise<ReceiptDto> {
  const body = new FormData();
  body.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch(
      `${claimPath(claimId)}/line-items/${encodeURIComponent(lineItemId)}/receipts`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: { accept: 'application/json' },
        body,
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'The upload failed. Check your connection and try again.',
    );
  }
  const rid = res.headers.get('x-request-id') ?? undefined;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(res.status, json, rid);
  const parsed = ReceiptResponse.safeParse(json);
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
// Copy

const TYPE_COPY = 'Only JPEG, PNG, WebP or PDF receipts are accepted.';
const SIZE_COPY = 'This file is too large. Receipts must be 10 MB or smaller.';
export const LIMIT_COPY = `A line item can have at most ${MAX_RECEIPTS_PER_LINE} receipts.`;

/**
 * Client pre-checks, UX only: the server re-checks the size, the declared type and the magic bytes.
 * Returns the message to show under the line, or null when the file may be sent.
 */
export function checkReceiptFile(file: File): string | null {
  if (!(RECEIPT_TYPES as readonly string[]).includes(file.type)) return TYPE_COPY;
  if (file.size > RECEIPT_MAX_BYTES) return SIZE_COPY;
  if (file.size === 0) return 'This file is empty. Choose another receipt.';
  return null;
}

const RECEIPT_COPY: Partial<Record<ClientErrorCode, string>> = {
  RECEIPT_TYPE_NOT_ALLOWED:
    'This file isn’t a valid JPEG, PNG, WebP or PDF, so it wasn’t attached.',
  RECEIPT_LIMIT_REACHED: LIMIT_COPY,
  SERVICE_UNAVAILABLE: 'Receipt storage is temporarily unavailable. Try again shortly.',
};

/** The message under a line's receipt list for a refused upload or remove (05 §5.2, §8). */
export function describeReceiptError(e: unknown): { title: string; requestId?: string } {
  const d = describeApiError(e);
  if (!(e instanceof ApiError)) return d;
  // A 413 can also come from a layer in front of the route, without our error envelope.
  if (e.code === 'PAYLOAD_TOO_LARGE' || e.status === 413) {
    return { title: SIZE_COPY, requestId: e.requestId };
  }
  const title = RECEIPT_COPY[e.code];
  return title ? { title, requestId: e.requestId } : d;
}

// ---------------------------------------------------------------------------------------------
// Display

const UNITS = ['KB', 'MB', 'GB'] as const;

/** 1023 → "1023 B", 245_760 → "240 KB", 10_380_902 → "9.9 MB" (binary units, as the limit). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.trunc(bytes))} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    value >= 10 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${shown} ${UNITS[unit]}`;
}
