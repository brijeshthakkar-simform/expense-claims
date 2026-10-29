import 'server-only';
import type { Actor } from '@/server/auth/actor';
import type { Tx } from '@/server/db/tx';
import { RECEIPT_ORDER } from '@/server/repositories/receipts.repo';
import { dateOnlyOfYmd, ymdOfDateOnly } from '@/shared/dates';

// Line items are reached only through their claim (04 §5.2). Every function takes
// (tx, actor, claimId, childId?) and binds each row to BOTH the path claim and its owner, so a line
// id from another claim can never be touched through mine (RT-B2). Callers hold lockOwnedClaim.
// The BEFORE ROW trigger re-checks editability; the AFTER STATEMENT triggers recompute the total.

export interface LineItemRow {
  id: string;
  categoryId: string;
  expenseDate: string; // YYYY-MM-DD
  amountMinor: number;
  description: string;
  merchant: string | null;
}

/** The writable columns of a line (claim_id always comes from the path, never the body). */
export type LineItemWrite = Omit<LineItemRow, 'id'>;

const mine = (actor: Actor, claimId: string) => ({ claimId, claim: { claimantId: actor.id } });

const toData = (l: LineItemWrite) => ({
  categoryId: l.categoryId,
  expenseDate: dateOnlyOfYmd(l.expenseDate),
  amountMinor: l.amountMinor,
  description: l.description,
  merchant: l.merchant,
});

/** The claim's current lines (a fresh statement after the lock: it sees the latest commit). */
export async function listForClaim(tx: Tx, actor: Actor, claimId: string): Promise<LineItemRow[]> {
  const rows = await tx.lineItem.findMany({
    where: mine(actor, claimId),
    orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      categoryId: true,
      expenseDate: true,
      amountMinor: true,
      description: true,
      merchant: true,
    },
  });
  return rows.map((r) => ({ ...r, expenseDate: ymdOfDateOnly(r.expenseDate) }));
}

/** Deletes the given lines of my claim; returns the count (the caller expects all of them). */
export async function deleteLines(
  tx: Tx,
  actor: Actor,
  claimId: string,
  lineItemIds: readonly string[],
): Promise<number> {
  const r = await tx.lineItem.deleteMany({
    where: { ...mine(actor, claimId), id: { in: [...lineItemIds] } },
  });
  return r.count;
}

/**
 * `UPDATE … WHERE id AND claim_id` (and owner): 1 = done, 0 = not a line of my claim. `at` is the
 * SeedClock instant (owner-run seed only) for updated_at; otherwise Prisma stamps it.
 */
export async function updateLine(
  tx: Tx,
  actor: Actor,
  claimId: string,
  lineItemId: string,
  line: LineItemWrite,
  at?: Date,
): Promise<number> {
  const r = await tx.lineItem.updateMany({
    where: { ...mine(actor, claimId), id: lineItemId },
    data: { ...toData(line), updatedAt: at },
  });
  return r.count;
}

/**
 * One multi-row INSERT: one lock + SUM + UPDATE of the total for the whole batch. `at` is the
 * SeedClock instant (owner-run seed only) for created_at/updated_at; otherwise they default.
 */
export async function insertLines(
  tx: Tx,
  _actor: Actor, // the claim is already locked as mine; kept for the uniform signature
  claimId: string,
  lines: readonly LineItemWrite[],
  at?: Date,
): Promise<number> {
  if (lines.length === 0) return 0;
  const r = await tx.lineItem.createMany({
    data: lines.map((l) => ({ ...toData(l), claimId, createdAt: at, updatedAt: at })),
  });
  return r.count;
}

/** A receipt as the C-21 snapshot freezes it (claim_submissions_verify v2 compares all six). */
export interface SnapshotReceiptRow {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

/**
 * A line as the C-21 snapshot freezes it: with its category's code, name, GL code and status, and
 * its receipts (storageKey + sha256, so evidence stays resolvable and verifiable after edits).
 */
export interface SnapshotLineRow extends LineItemRow {
  category: { id: string; code: string; name: string; glCode: string; isActive: boolean };
  receipts: SnapshotReceiptRow[];
}

/**
 * The lines to submit, in snapshot order (expense_date, id), read with a fresh statement after the
 * claim lock. claim_submissions_verify compares the snapshot built from these with the live rows.
 */
export async function listForSnapshot(
  tx: Tx,
  actor: Actor,
  claimId: string,
): Promise<SnapshotLineRow[]> {
  const rows = await tx.lineItem.findMany({
    where: mine(actor, claimId),
    orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      categoryId: true,
      expenseDate: true,
      amountMinor: true,
      description: true,
      merchant: true,
      category: { select: { id: true, code: true, name: true, glCode: true, isActive: true } },
      receipts: {
        orderBy: [...RECEIPT_ORDER],
        select: {
          id: true,
          fileName: true,
          contentType: true,
          sizeBytes: true,
          sha256: true,
          storageKey: true,
        },
      },
    },
  });
  return rows.map((r) => ({ ...r, expenseDate: ymdOfDateOnly(r.expenseDate) }));
}
