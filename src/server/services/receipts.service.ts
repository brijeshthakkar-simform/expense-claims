import 'server-only';
import { createHash } from 'node:crypto';
import { assertOk, decide, type ClaimFacts } from '@/server/authz/claim-policy';
import { withTx } from '@/server/db/tx';
import { AppError } from '@/server/errors/app-error';
import { logEvent, logger } from '@/server/logging/logger';
import * as claimsRepo from '@/server/repositories/claims.repo';
import { expectOne } from '@/server/repositories/claims.repo';
import * as receiptsRepo from '@/server/repositories/receipts.repo';
import type { ReceiptDtoRow } from '@/server/repositories/receipts.repo';
import { toReceiptDto } from '@/server/services/claim-dto';
import type { ServiceCtx } from '@/server/services/context';
import { getStorage, newReceiptKey } from '@/server/storage/receipt-storage';
import {
  allowedDeclaredType,
  sniffReceiptType,
  type ReceiptContentType,
} from '@/server/storage/sniff';
import type { ReceiptDto } from '@/shared/dto/claims';
import type { ApiIssue } from '@/shared/errors';
import { MAX_RECEIPTS_PER_LINE, RECEIPT_MAX_BYTES } from '@/shared/policy';

// Receipts per line item (D-30, D-31; 06 §5). Bytes go to ReceiptStorage OUTSIDE any transaction
// (D-14: no network I/O inside one); the DB row is written under the owner-scoped claim lock and
// re-checked by receipts_10_before_write. Storage objects are deleted only for claims that were
// never submitted (current_revision = 0), so snapshot evidence can never be garbage-collected.

/** What upload() needs from a multipart part: a Web `File` satisfies it. */
export type ReceiptFile = Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>;

/** A streamed download; the route turns it into the attachment response. */
export interface ReceiptContent {
  body: ReadableStream<Uint8Array>;
  sizeBytes: number;
  fileName: string;
  /** The stored (sniffed) type from the DB or snapshot, never the store's metadata. */
  contentType: string;
}

const ownerFacts = (c: {
  status: ClaimFacts['status'];
  claimantId: string;
  currentRevision: number;
}): ClaimFacts => ({
  status: c.status,
  claimantId: c.claimantId,
  currentRevision: c.currentRevision,
  myStepOnCurrentRevision: null, // receipts are owner actions
});

const fileIssue = (message: string): { issues: ApiIssue[] } => ({
  issues: [{ path: ['file'], message, code: 'custom' }],
});

/** A store outage is 503 SERVICE_UNAVAILABLE for the receipt route only (06 §3.2). */
async function storageCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new AppError('SERVICE_UNAVAILABLE', undefined, undefined, { cause: err });
  }
}

const EXTENSION: Record<ReceiptContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Display name only (stored in the DB, never in a key or a path): the basename, without control
 * characters, trimmed to 255 characters (varchar(255) counts code points).
 */
export function cleanFileName(raw: string, type: ReceiptContentType): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = Array.from(base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .slice(0, 255)
    .join('')
    .trim();
  return cleaned.length > 0 ? cleaned : `receipt.${EXTENSION[type]}`;
}

/**
 * POST …/line-items/:lineItemId/receipts (06 §5.4), in the PLAN P6 order. The route has already
 * refused a Content-Length over the cap and parsed the multipart body through a byte limit.
 *   1. size (413) · 2. allowlist + magic bytes (422) · 3. sha256 · 4. precheck without a lock:
 *   owner claim, editable, line on the claim, < 5 receipts · 5. storage.put (no tx) · 6. withTx:
 *   lock, re-check, INSERT · 7. on failure, best-effort storage.delete.
 */
export async function upload(
  ctx: ServiceCtx,
  claimId: string,
  lineItemId: string,
  file: ReceiptFile,
): Promise<ReceiptDto> {
  const { actor } = ctx;

  // 1. Size.
  if (file.size > RECEIPT_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
  if (file.size === 0) throw new AppError('VALIDATION_FAILED', undefined, fileIssue('Empty file'));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > RECEIPT_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');

  // 2. The declared type must be allowlisted AND the magic bytes must prove the same type.
  const declared = allowedDeclaredType(file.type);
  const sniffed = sniffReceiptType(bytes);
  if (!declared || sniffed !== declared) throw new AppError('RECEIPT_TYPE_NOT_ALLOWED');

  // 3. The evidence hash, stored on the row and later frozen into the snapshot.
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 4. Precheck before touching storage (no bytes written for a request that will fail anyway).
  const target = await receiptsRepo.findUploadTarget(actor, claimId, lineItemId);
  if (!target) throw new AppError('CLAIM_NOT_FOUND');
  assertOk(decide(actor, ownerFacts(target)).EDIT); // non-owner 404; 409 LOCKED / NOT_EDITABLE
  if (!target.line) throw new AppError('LINE_ITEM_NOT_FOUND');
  if (target.line.receiptCount >= MAX_RECEIPTS_PER_LINE)
    throw new AppError('RECEIPT_LIMIT_REACHED');

  // 5. The object, under a fresh key, outside any transaction.
  const storageKey = newReceiptKey(claimId, lineItemId);
  await storageCall(() => getStorage().put(storageKey, bytes, { contentType: sniffed, sha256 }));

  // 6. The row, under the lock, after the same checks again.
  let row: ReceiptDtoRow;
  try {
    row = await withTx(async (tx) => {
      const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
      if (!claim) throw new AppError('CLAIM_NOT_FOUND');
      assertOk(decide(actor, ownerFacts(claim)).EDIT);
      const count = await receiptsRepo.countOnLine(tx, actor, claimId, lineItemId);
      if (count === null) throw new AppError('LINE_ITEM_NOT_FOUND');
      if (count >= MAX_RECEIPTS_PER_LINE) throw new AppError('RECEIPT_LIMIT_REACHED');
      return receiptsRepo.insert(tx, actor, claimId, lineItemId, {
        storageKey,
        fileName: cleanFileName(file.name, sniffed),
        contentType: sniffed,
        sizeBytes: bytes.byteLength,
        sha256,
        createdAt: ctx.clock?.now(), // SeedClock only: the seeded C04 receipt predates its submit
      });
    });
  } catch (err) {
    // 7. Nothing references the object: remove it (an orphan is harmless if this fails, 06 §5.8).
    await discardObjects([storageKey], { claimId, lineItemId, reason: 'upload_rolled_back' });
    throw err;
  }

  logEvent('receipt.uploaded', {
    claimId,
    lineItemId,
    receiptId: row.id,
    sizeBytes: row.sizeBytes,
    contentType: row.contentType,
  });
  return toReceiptDto(row);
}

/**
 * GET …/receipts/:receiptId/content (06 §5.5): the claim through the visibility predicate (404
 * CLAIM_NOT_FOUND), then the receipt within that claim only: the live row, else one this claim's
 * submission snapshots still reference (evidence survives line deletion). Then stream the bytes.
 */
export async function download(
  ctx: ServiceCtx,
  claimId: string,
  receiptId: string,
): Promise<ReceiptContent> {
  const found = await receiptsRepo.findLiveForDownload(ctx.actor, claimId, receiptId);
  if (!found.visible) throw new AppError('CLAIM_NOT_FOUND');
  const receipt = found.receipt ?? (await receiptsRepo.findInSnapshots(claimId, receiptId));
  if (!receipt) throw new AppError('RECEIPT_NOT_FOUND');

  const object = await storageCall(() => getStorage().get(receipt.storageKey));
  if (!object) {
    // A row or snapshot points at bytes that are gone: an integrity incident, not a 404.
    logger.error(
      { claimId, receiptId, storageKey: receipt.storageKey },
      'receipt object missing from storage',
    );
    throw new AppError('INTERNAL_ERROR');
  }
  if (object.sizeBytes !== receipt.sizeBytes)
    logger.error(
      { claimId, receiptId, storageKey: receipt.storageKey, stored: object.sizeBytes },
      'receipt object size differs from the recorded size',
    );
  return {
    body: object.body,
    sizeBytes: object.sizeBytes,
    fileName: receipt.fileName,
    contentType: receipt.contentType,
  };
}

/**
 * DELETE …/receipts/:receiptId (06 §5.6): lock my claim (404) → editable (409) → the receipt on
 * this claim (404 RECEIPT_NOT_FOUND) → DELETE the row (the trigger re-checks) → after commit, the
 * D-31 retention rule: the object goes only if the claim was never submitted.
 */
export async function deleteReceipt(
  ctx: ServiceCtx,
  claimId: string,
  receiptId: string,
): Promise<void> {
  const { actor } = ctx;
  const done = await withTx(async (tx) => {
    const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
    if (!claim) throw new AppError('CLAIM_NOT_FOUND');
    assertOk(decide(actor, ownerFacts(claim)).EDIT);
    const receipt = await receiptsRepo.findOnClaim(tx, actor, claimId, receiptId);
    if (!receipt) throw new AppError('RECEIPT_NOT_FOUND');
    expectOne(await receiptsRepo.deleteOne(tx, actor, claimId, receiptId));
    return { ...receipt, currentRevision: claim.currentRevision };
  });

  const objectDeleted =
    done.currentRevision === 0 &&
    (await discardObjects([done.storageKey], { claimId, reason: 'receipt_deleted' })) === 1;
  logEvent('receipt.deleted', {
    claimId,
    lineItemId: done.lineItemId,
    receiptId,
    objectDeleted,
  });
}

/**
 * After commit only: best-effort delete of objects no row references any more. A failure is
 * logged as `receipt.object_orphaned` (warn) and never fails the request (06 §5.8). Returns how
 * many were deleted. Callers apply the D-31 rule (current_revision = 0) before calling this.
 */
export async function discardObjects(
  keys: readonly string[],
  fields: Record<string, unknown> = {},
): Promise<number> {
  const results = await Promise.all(
    keys.map(async (storageKey) => {
      try {
        await getStorage().delete(storageKey);
        return true;
      } catch (err) {
        logEvent('receipt.object_orphaned', { ...fields, storageKey, err }, 'warn');
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}
