import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import type { Tx } from '@/server/db/tx';
import type { ClaimEventType, ClaimStatus, EventActorRole } from '@/shared/enums';

// claim_events (02 §10): append-only. expense_app has SELECT + INSERT only, forbid_mutation()
// raises UC007 on UPDATE/DELETE for everyone, and for expense_app the DB stamps occurred_at and
// tx_id. The only caller is recordEvent() (src/server/audit/record-event.ts).

export interface EventInsert {
  claimId: string;
  submissionId: string;
  stepId: string | null;
  revision: number;
  type: ClaimEventType;
  actorId: string;
  actorRole: EventActorRole;
  fromStatus: ClaimStatus;
  toStatus: ClaimStatus;
  totalMinor: number;
  reason: string | null;
  /** Validated by ClaimEventInputSchema: plain JSON (strings, numbers, arrays, objects). */
  payload: object;
  requestId: string;
  /** SeedClock only; the DB overwrites it for expense_app (D-23). */
  occurredAt?: Date;
}

export async function insert(tx: Tx, e: EventInsert): Promise<{ id: string }> {
  // tx_id is never sent: its default (and, for expense_app, the trigger) is this transaction's id,
  // which assert_transition_audited matches at COMMIT (UC015).
  return tx.claimEvent.create({
    data: { ...e, payload: e.payload as Prisma.InputJsonObject },
    select: { id: true },
  });
}
