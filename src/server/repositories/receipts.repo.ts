import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import type { Tx } from '@/server/db/tx';
import { findClaimForActor } from '@/server/repositories/claim-visibility';
import type { ClaimStatus } from '@/shared/enums';

// Receipts are reached only through their claim (04 §5.2): writes as (tx, actor, claimId,
// childId?) under the owner-scoped claim lock, reads after the visibility predicate, inside the same
// SELECT. receipts_10_before_write re-checks editability (UC001/UC002) and the composite FK
// (line_item_id, claim_id) → line_items(id, claim_id) pins every row to its line's claim.

/** What ReceiptDto is built from (C-10). */
export const RECEIPT_DTO_SELECT = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.ReceiptSelect;
export type ReceiptDtoRow = Prisma.ReceiptGetPayload<{ select: typeof RECEIPT_DTO_SELECT }>;

/** A line's receipts in display/snapshot order. */
export const RECEIPT_ORDER = [
  { createdAt: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.ReceiptOrderByWithRelationInput[];

/** Owner scope for a receipt: its line belongs to MY claim at this path. */
const mine = (actor: Actor, claimId: string) => ({
  claimId,
  lineItem: { claim: { claimantId: actor.id } },
});

// ------------------------------------------------------------------------------ upload

export interface UploadTarget {
  status: ClaimStatus;
  claimantId: string;
  currentRevision: number;
  /** null = no such line on this claim. */
  line: { receiptCount: number } | null;
}

/**
 * The upload precheck (06 §5.4 step 4), no lock: the claim through the visibility predicate (null
 * = 404 for the caller), its status, and the path line's receipt count, in one SELECT.
 */
export async function findUploadTarget(
  actor: Actor,
  claimId: string,
  lineItemId: string,
): Promise<UploadTarget | null> {
  const row = await findClaimForActor(actor, claimId, {
    status: true,
    claimantId: true,
    currentRevision: true,
    lineItems: {
      where: { id: lineItemId },
      select: { _count: { select: { receipts: true } } },
    },
  });
  if (!row) return null;
  const line = row.lineItems[0];
  return {
    status: row.status,
    claimantId: row.claimantId,
    currentRevision: row.currentRevision,
    line: line ? { receiptCount: line._count.receipts } : null,
  };
}

/**
 * Under the lock: the receipt count of the path line on MY claim (null = not a line of it). A
 * fresh statement after lockOwnedClaim, so two uploads racing for the 5th slot serialize.
 */
export async function countOnLine(
  tx: Tx,
  actor: Actor,
  claimId: string,
  lineItemId: string,
): Promise<number | null> {
  const line = await tx.lineItem.findFirst({
    where: { id: lineItemId, claimId, claim: { claimantId: actor.id } },
    select: { _count: { select: { receipts: true } } },
  });
  return line ? line._count.receipts : null;
}

export interface ReceiptInsert {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** The SeedClock instant (owner-run seed only); otherwise the column default stamps now(). */
  createdAt?: Date;
}

/** INSERT one receipt on the path line of my (locked) claim; the uploader is the actor. */
export function insert(
  tx: Tx,
  actor: Actor,
  claimId: string,
  lineItemId: string,
  r: ReceiptInsert,
): Promise<ReceiptDtoRow> {
  return tx.receipt.create({
    data: { ...r, claimId, lineItemId, uploadedById: actor.id },
    select: RECEIPT_DTO_SELECT,
  });
}

// ------------------------------------------------------------------------------ delete

/** Under the lock: a receipt of MY claim at this path, or null (404 RECEIPT_NOT_FOUND). */
export function findOnClaim(
  tx: Tx,
  actor: Actor,
  claimId: string,
  receiptId: string,
): Promise<{ id: string; lineItemId: string; storageKey: string } | null> {
  return tx.receipt.findFirst({
    where: { ...mine(actor, claimId), id: receiptId },
    select: { id: true, lineItemId: true, storageKey: true },
  });
}

/** `DELETE … WHERE id AND claim_id` (and owner): 1 = done. */
export async function deleteOne(
  tx: Tx,
  actor: Actor,
  claimId: string,
  receiptId: string,
): Promise<number> {
  const r = await tx.receipt.deleteMany({ where: { ...mine(actor, claimId), id: receiptId } });
  return r.count;
}

/** C-25 receipt-key step (PUT): the storage keys of the receipts on the lines about to be removed. */
export async function storageKeysForLines(
  tx: Tx,
  actor: Actor,
  claimId: string,
  lineItemIds: readonly string[],
): Promise<string[]> {
  if (lineItemIds.length === 0) return [];
  const rows = await tx.receipt.findMany({
    where: { ...mine(actor, claimId), lineItemId: { in: [...lineItemIds] } },
    select: { storageKey: true },
  });
  return rows.map((r) => r.storageKey);
}

/** C-25 receipt-key step (draft delete): every receipt key of my claim. */
export async function storageKeysForClaim(
  tx: Tx,
  actor: Actor,
  claimId: string,
): Promise<string[]> {
  const rows = await tx.receipt.findMany({
    where: mine(actor, claimId),
    select: { storageKey: true },
  });
  return rows.map((r) => r.storageKey);
}

// ------------------------------------------------------------------------------ download

export interface DownloadableReceipt {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export type DownloadLookup =
  { visible: false } | { visible: true; receipt: DownloadableReceipt | null };

/**
 * 06 §5.5 steps 1–2a in ONE SELECT: the claim through the visibility predicate (refused at the
 * point of the query) and, only within that claim, the live receipt row.
 */
export async function findLiveForDownload(
  actor: Actor,
  claimId: string,
  receiptId: string,
): Promise<DownloadLookup> {
  const row = await findClaimForActor(actor, claimId, {
    id: true,
    lineItems: {
      where: { receipts: { some: { id: receiptId } } },
      select: {
        receipts: {
          where: { id: receiptId },
          select: { storageKey: true, fileName: true, contentType: true, sizeBytes: true },
        },
      },
    },
  });
  if (!row) return { visible: false };
  return { visible: true, receipt: row.lineItems[0]?.receipts[0] ?? null };
}

/**
 * 06 §5.5 step 2b: a receipt that only one of THIS claim's submission snapshots still references
 * (e.g. its line was deleted after a rejection). Called only after the claim passed the
 * visibility predicate; the newest revision wins. A handful of rows: one claim's submissions.
 */
export async function findInSnapshots(
  claimId: string,
  receiptId: string,
): Promise<DownloadableReceipt | null> {
  const rows = await getDb().$queryRaw<DownloadableReceipt[]>`
    SELECT r->>'storageKey' AS "storageKey", r->>'fileName' AS "fileName",
           r->>'contentType' AS "contentType", (r->>'sizeBytes')::int AS "sizeBytes"
      FROM public.claim_submissions s
     CROSS JOIN LATERAL jsonb_array_elements(s.snapshot->'lines') l
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l->'receipts', '[]'::jsonb)) r
     WHERE s.claim_id = ${claimId}::uuid AND r->>'receiptId' = ${receiptId}
     ORDER BY s.revision DESC
     LIMIT 1`;
  return rows[0] ?? null;
}
