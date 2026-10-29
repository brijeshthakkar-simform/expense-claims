// Raw, SQL-only transitions in the C-25 write orders (the SQL proof's fixtures.mjs `submit` and
// `decide`), for the DB-backstop tests (TC-I15, TC-I23) and the owner-backdated decisions
// (ownerDecideAt, TC-I25). Each hook forges one part, so every attack is a one-liner and the honest
// call (no hooks) is the positive control that proves the helper itself is sound. Services never
// write this way: fixtures that should succeed use submitAs() / approveAs() / rejectAs().
import { randomUUID } from 'node:crypto';
import type { SnapshotV1 } from '@/shared/dto/snapshot';
import { L4_TIER, TIERS } from '../../prisma/seed-personas';
import { tx, type Sql, type TestClient } from './db';

export interface RawStep {
  level: number;
  tierCode: string;
  tierLabel: string;
  appliesAboveMinor: number;
  approverId: string;
  resolvedVia: 'PRIMARY' | 'ESCALATED' | 'FALLBACK';
  /** Default: level 1 PENDING, the rest WAITING (what the guard requires). */
  status?: 'PENDING' | 'WAITING';
}

/** A step copying the C-13 tier at `level` (1–4), as buildChain would plan it. */
export function tierStep(
  level: number,
  approverId: string,
  resolvedVia: RawStep['resolvedVia'] = 'PRIMARY',
): RawStep {
  const t = [...TIERS, L4_TIER].find((x) => x.level === level);
  if (!t) throw new Error(`no C-13 tier at level ${level}`);
  return {
    level,
    tierCode: t.code,
    tierLabel: t.label,
    appliesAboveMinor: t.appliesAboveMinor,
    approverId,
    resolvedVia,
  };
}

/** The honest C-21 snapshot v1 of the claim's live rows, built in SQL. */
export async function snapshotOf(sql: Sql, claimId: string): Promise<SnapshotV1> {
  const [row] = await sql<{ snapshot: SnapshotV1 }>`
    SELECT jsonb_build_object(
             'v', 1,
             'claimant', jsonb_build_object('id', u.id, 'employeeCode', u.employee_code,
                                            'name', u.name, 'email', u.email,
                                            'departmentCode', d.code),
             'title', c.title, 'currency', c.currency, 'totalMinor', c.total_minor,
             'lines', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'lineItemId', li.id, 'expenseDate', li.expense_date,
                        'categoryId', li.category_id, 'categoryCode', cat.code,
                        'categoryName', cat.name, 'glCode', cat.gl_code,
                        'amountMinor', li.amount_minor, 'description', li.description,
                        'merchant', li.merchant, 'receipts', '[]'::jsonb)
                        ORDER BY li.expense_date, li.id)
                 FROM line_items li JOIN categories cat ON cat.id = li.category_id
                WHERE li.claim_id = c.id), '[]'::jsonb)) AS snapshot
      FROM claims c
      JOIN users u ON u.id = c.claimant_id
      JOIN departments d ON d.id = u.department_id
     WHERE c.id = ${claimId}`;
  if (!row) throw new Error(`no claim ${claimId}`);
  return row.snapshot;
}

export interface RawEvent {
  type: string;
  actorId: string;
  actorRole: 'CLAIMANT' | 'APPROVER';
  fromStatus: string;
  toStatus: string;
  revision: number;
  submissionId: string | null;
  /** The decided step (decision events only). */
  stepId?: string | null;
  /** Rejection reason or approval comment. */
  reason?: string | null;
  totalMinor: number;
  payload: Record<string, unknown>;
  requestId: string;
  /** Kept only for the owner (expense_app inserts are re-stamped with now()); default now(). */
  occurredAt?: string | null;
}

export interface RawSubmitHooks {
  /** The honest chain is required: the helper does not route. */
  chain: RawStep[];
  snapshot?: (s: SnapshotV1) => SnapshotV1;
  revision?: number;
  submittedById?: string;
  /** Runs after the submission and steps are inserted, before UPDATE claims. */
  beforeClaimUpdate?: (c: TestClient, ids: { submissionId: string }) => Promise<unknown>;
  /** Rewrite the event, or return null to skip it. */
  event?: (e: RawEvent) => RawEvent | null;
  /**
   * The submit instant (ISO): the submission's and the claim's submitted_at and the event's
   * occurred_at. Only the owner's value is kept (D-23); for expense_app the DB stamps now().
   */
  at?: string;
}

/** BEGIN … COMMIT on `c` (an appClient()): deferred checks (UC015) fire at COMMIT, inside. */
export async function rawSubmit(
  c: TestClient,
  claimId: string,
  hooks: RawSubmitHooks,
): Promise<{ submissionId: string }> {
  return tx(c, async () => {
    const [claim] = await c.sql<{
      claimant_id: string;
      status: string;
      current_revision: number;
      total_minor: number;
      currency: string;
    }>`SELECT claimant_id, status, current_revision, total_minor, currency
         FROM claims WHERE id = ${claimId} FOR NO KEY UPDATE`;
    if (!claim) throw new Error(`no claim ${claimId}`);
    const revision = claim.current_revision + 1;
    const honest = await snapshotOf(c.sql, claimId);
    const snapshot = hooks.snapshot ? hooks.snapshot(structuredClone(honest)) : honest;

    const [sub] = await c.sql<{ id: string }>`
      INSERT INTO claim_submissions (claim_id, revision, submitted_by_id, total_minor, currency,
                                     line_item_count, snapshot, submitted_at)
      VALUES (${claimId}, ${hooks.revision ?? revision}, ${hooks.submittedById ?? claim.claimant_id},
              ${claim.total_minor}, ${claim.currency}, ${snapshot.lines.length},
              ${JSON.stringify(snapshot)}::jsonb, COALESCE(${hooks.at ?? null}::timestamptz, now()))
      RETURNING id`;
    const submissionId = sub!.id;
    for (const s of hooks.chain)
      await c.sql`
        INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label,
                                    applies_above_minor, approver_id, resolved_via, status)
        VALUES (${claimId}, ${submissionId}, ${s.level}, ${s.tierCode}, ${s.tierLabel},
                ${s.appliesAboveMinor}, ${s.approverId}, ${s.resolvedVia},
                ${s.status ?? (s.level === 1 ? 'PENDING' : 'WAITING')}::approval_step_status)`;
    await hooks.beforeClaimUpdate?.(c, { submissionId });

    await c.sql`
      UPDATE claims SET status = 'SUBMITTED', current_revision = ${revision},
                        current_submission_id = ${submissionId},
                        submitted_at = COALESCE(${hooks.at ?? null}::timestamptz, submitted_at)
       WHERE id = ${claimId}`;

    const honestEvent: RawEvent = {
      type: claim.status === 'REJECTED' ? 'CLAIM_RESUBMITTED' : 'CLAIM_SUBMITTED',
      actorId: claim.claimant_id,
      actorRole: 'CLAIMANT',
      fromStatus: claim.status,
      toStatus: 'SUBMITTED',
      revision,
      submissionId,
      totalMinor: claim.total_minor,
      payload: {
        lineItemCount: snapshot.lines.length,
        chain: hooks.chain.map(({ level, tierCode, approverId, resolvedVia }) => ({
          level,
          tierCode,
          approverId,
          resolvedVia,
        })),
      },
      requestId: `test-${randomUUID()}`,
      occurredAt: hooks.at ?? null,
    };
    const e = hooks.event ? hooks.event(honestEvent) : honestEvent;
    if (e) await insertEvent(c.sql, claimId, e);
    return { submissionId };
  });
}

/** A raw claim_events INSERT (the app role may insert; the DB stamps occurred_at and tx_id). */
export async function insertEvent(sql: Sql, claimId: string, e: RawEvent): Promise<void> {
  await sql`
    INSERT INTO claim_events (claim_id, submission_id, step_id, revision, type, actor_id,
                              actor_role, from_status, to_status, total_minor, reason, payload,
                              request_id, occurred_at)
    VALUES (${claimId}, ${e.submissionId}, ${e.stepId ?? null}, ${e.revision},
            ${e.type}::claim_event_type, ${e.actorId}, ${e.actorRole}::event_actor_role,
            ${e.fromStatus}::claim_status, ${e.toStatus}::claim_status, ${e.totalMinor},
            ${e.reason ?? null}, ${JSON.stringify(e.payload)}::jsonb, ${e.requestId},
            COALESCE(${e.occurredAt ?? null}::timestamptz, now()))`;
}

export interface RawDecision {
  /** Whose PENDING step on the claim's current submission is decided. */
  approverId: string;
  outcome: 'APPROVED' | 'REJECTED';
  /**
   * The decision instant (ISO). Becomes decided_at, the next level's activated_at, approved_at /
   * rejected_at, the cancelled_at of later WAITING steps and the event's occurred_at. Only the
   * owner's values are kept (D-23); for expense_app the DB stamps now() over all of them.
   */
  at?: string;
  /** The rejection reason (default: C05's), or an approval comment. */
  reason?: string;
  comment?: string;
  /** Rewrite the decision event, or return null to skip it. */
  event?: (e: RawEvent) => RawEvent | null;
}

/**
 * A raw approve or reject on `c` (an appClient() or ownerClient()) in the C-25 order: lock the
 * claim → my PENDING step on current_submission_id → step PENDING → APPROVED | REJECTED → next level
 * WAITING → PENDING, or claim → APPROVED; or later WAITING steps → CANCELLED and claim → REJECTED →
 * one typed event (C-20 payloads) → COMMIT, where the deferred UC015 checks run.
 */
export async function rawDecide(
  c: TestClient,
  claimId: string,
  d: RawDecision,
): Promise<{ stepId: string; nextStepId: string | null; cancelledStepIds: string[] }> {
  return tx(c, async () => {
    const at = d.at ?? null;
    const [claim] = await c.sql<{
      current_revision: number;
      current_submission_id: string | null;
      total_minor: number;
    }>`SELECT current_revision, current_submission_id, total_minor
         FROM claims WHERE id = ${claimId} FOR NO KEY UPDATE`;
    if (!claim?.current_submission_id) throw new Error(`claim ${claimId} is not in approval`);
    const submissionId = claim.current_submission_id;
    const [step] = await c.sql<{ id: string; level: number; tier_code: string; n: number }>`
      SELECT s.id, s.level, s.tier_code,
             (SELECT count(*)::int FROM approval_steps x WHERE x.submission_id = s.submission_id) AS n
        FROM approval_steps s
       WHERE s.submission_id = ${submissionId} AND s.approver_id = ${d.approverId}
         AND s.status = 'PENDING'`;
    if (!step) throw new Error(`no PENDING step of ${d.approverId} on claim ${claimId}`);
    const decision = { level: step.level, levelCount: step.n, tierCode: step.tier_code };
    const base = {
      actorId: d.approverId,
      actorRole: 'APPROVER' as const,
      fromStatus: 'SUBMITTED',
      revision: claim.current_revision,
      submissionId,
      stepId: step.id,
      totalMinor: claim.total_minor,
      requestId: `test-${randomUUID()}`,
      occurredAt: at,
    };
    let honest: RawEvent;
    let nextStepId: string | null = null;
    let cancelledStepIds: string[] = [];

    if (d.outcome === 'APPROVED') {
      await c.sql`
        UPDATE approval_steps SET status = 'APPROVED', comment = ${d.comment ?? null},
                                  decided_at = ${at}::timestamptz
         WHERE id = ${step.id} AND status = 'PENDING'`;
      const [next] = await c.sql<{ id: string; approver_id: string }>`
        UPDATE approval_steps SET status = 'PENDING', activated_at = ${at}::timestamptz
         WHERE submission_id = ${submissionId} AND level = ${step.level + 1} AND status = 'WAITING'
        RETURNING id, approver_id`;
      if (next) {
        nextStepId = next.id;
        honest = {
          ...base,
          type: 'STEP_APPROVED',
          toStatus: 'SUBMITTED',
          reason: d.comment ?? null,
          payload: { ...decision, nextApproverId: next.approver_id },
        };
      } else {
        await c.sql`
          UPDATE claims SET status = 'APPROVED', approved_at = ${at}::timestamptz
           WHERE id = ${claimId} AND status = 'SUBMITTED'`;
        const approvers = await c.sql<{ approver_id: string }>`
          SELECT approver_id FROM approval_steps WHERE submission_id = ${submissionId} ORDER BY level`;
        honest = {
          ...base,
          type: 'CLAIM_APPROVED',
          toStatus: 'APPROVED',
          reason: d.comment ?? null,
          payload: { ...decision, approverIds: approvers.map((r) => r.approver_id) },
        };
      }
    } else {
      const reason = d.reason ?? 'Hotel invoice missing for 3 Oct';
      await c.sql`
        UPDATE approval_steps SET status = 'REJECTED', rejection_reason = ${reason},
                                  decided_at = ${at}::timestamptz
         WHERE id = ${step.id} AND status = 'PENDING'`;
      const cancelled = await c.sql<{ id: string; level: number }>`
        UPDATE approval_steps SET status = 'CANCELLED', cancelled_at = ${at}::timestamptz
         WHERE submission_id = ${submissionId} AND status = 'WAITING'
        RETURNING id, level`;
      cancelledStepIds = cancelled.sort((a, b) => a.level - b.level).map((r) => r.id);
      await c.sql`
        UPDATE claims SET status = 'REJECTED', rejected_at = ${at}::timestamptz
         WHERE id = ${claimId} AND status = 'SUBMITTED'`;
      honest = {
        ...base,
        type: 'CLAIM_REJECTED',
        toStatus: 'REJECTED',
        reason,
        payload: { ...decision, cancelledStepIds },
      };
    }
    const e = d.event ? d.event(honest) : honest;
    if (e) await insertEvent(c.sql, claimId, e);
    return { stepId: step.id, nextStepId, cancelledStepIds };
  });
}
