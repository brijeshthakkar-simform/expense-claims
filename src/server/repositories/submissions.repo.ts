import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import type { Tx } from '@/server/db/tx';
import type { SnapshotV1 } from '@/shared/dto/snapshot';

// claim_submissions: one INSERT-only row per (re)submission (UC007 on UPDATE/DELETE; expense_app
// has SELECT + INSERT only). claim_submissions_verify locks the claim, freezes it (BUG-2) and
// proves the snapshot equals the live lines, total and claimant (UC004 / UC016) before insert.

export interface SubmissionInsert {
  claimId: string;
  revision: number;
  submittedById: string;
  totalMinor: number;
  currency: string;
  lineItemCount: number;
  snapshot: SnapshotV1;
  /** SeedClock only; the DB stamps now() for expense_app (D-23). */
  submittedAt?: Date;
}

export function insert(tx: Tx, s: SubmissionInsert): Promise<{ id: string; revision: number }> {
  return tx.claimSubmission.create({
    data: { ...s, snapshot: s.snapshot as unknown as Prisma.InputJsonObject },
    select: { id: true, revision: true },
  });
}

/** The previous revision's header, for the next submit event's `previousRevision`. */
export function summary(
  tx: Tx,
  submissionId: string,
): Promise<{ revision: number; totalMinor: number } | null> {
  return tx.claimSubmission.findUnique({
    where: { id: submissionId },
    select: { revision: true, totalMinor: true },
  });
}
