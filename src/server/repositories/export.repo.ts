import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { requireRole, type Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import type { ExportClaimRow } from '@/server/export/csv';
import type { ExportCursor } from '@/server/export/export-stream';
import { SnapshotV1 } from '@/shared/dto/snapshot';

// The approved-claims export (06 §6.2–6.6, D-32). No transaction: each batch is one READ COMMITTED
// statement on the pool, and the connection goes back between pulls, so a stalled browser pins no
// pool slot and no snapshot. Closed periods are still exact (06 §6.7): APPROVED is terminal, the
// stamps are DB-owned and immutable, and `approved_at < asOf` keeps later approvals out.

/**
 * The DB clock at request start (`clock_timestamp()`, not `now()`: no transaction is open, and the
 * DB stamps approved_at, so there is no app/DB skew). Truncated to milliseconds so the JS Date, the
 * X-Export-As-Of header and the predicate are the same instant. Also proves the DB is reachable
 * before the route commits to a 200 (a failure here is a JSON 503, not a broken download).
 */
export async function asOfNow(): Promise<Date> {
  const rows = await getDb().$queryRaw<{ asOf: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS "asOf"`;
  const asOf = rows[0]?.asOf;
  if (!(asOf instanceof Date)) throw new Error('clock_timestamp() returned no instant');
  return asOf;
}

export interface ApprovedClaimsBatchArgs {
  /** Period start, inclusive: from 00:00 IST. */
  gte: Date;
  /** Period end, exclusive: (to + 1) 00:00 IST. */
  lt: Date;
  /** Approvals at or after this instant are excluded (they began during the export). */
  asOf: Date;
  /** Keyset position: claims strictly after (approved_at, id). null = the first batch. */
  after: ExportCursor | null;
  limit: number;
}

interface BatchRow {
  id: string;
  claimNumber: string;
  revision: number;
  approvedAt: Date;
  submittedAt: Date;
  finalApproverEmail: string | null;
  snapshot: unknown;
}

// Instants travel as ISO strings with an explicit cast: no dependence on the session TimeZone.
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz`;

/**
 * The batch SQL (exported for the EXPLAIN capture, which must run the app's exact statement).
 * Keyset on (approved_at, id) served by claims_export_idx: the row comparison is one btree Index
 * Cond, so every batch is an index range scan of `limit` entries with no Sort, O(batch) at any
 * depth. The page CTE picks claims only; the joins then read each claim's APPROVED submission
 * (claims.current_submission_id: INSERT-only, DB-verified against the lines, UC016) and its final
 * approver (the highest-level APPROVED step of that submission). The LATERAL reads approval_steps
 * alone, so `ORDER BY level DESC LIMIT 1` is a backward scan of
 * approval_steps_submission_id_level_key that stops at the first APPROVED step (no top-1 Sort), and
 * the email is a users_pkey lookup for that one row only.
 */
export function approvedClaimsBatchSql(a: ApprovedClaimsBatchArgs): Prisma.Sql {
  const afterCond = a.after
    ? Prisma.sql`AND (c.approved_at, c.id) > (${ts(a.after.approvedAt)}, ${a.after.id}::uuid)`
    : Prisma.empty;
  return Prisma.sql`
    WITH page AS (
      SELECT c.id, c.claim_number, c.current_revision, c.approved_at, c.current_submission_id
        FROM public.claims c
       WHERE c.status = 'APPROVED'
         AND c.approved_at >= ${ts(a.gte)} AND c.approved_at < ${ts(a.lt)}
         AND c.approved_at < ${ts(a.asOf)}
         ${afterCond}
       ORDER BY c.approved_at, c.id
       LIMIT ${a.limit}
    )
    SELECT p.id, p.claim_number AS "claimNumber", p.current_revision AS revision,
           p.approved_at AS "approvedAt", s.submitted_at AS "submittedAt", s.snapshot,
           fa.email AS "finalApproverEmail"
      FROM page p
      JOIN public.claim_submissions s ON s.id = p.current_submission_id AND s.claim_id = p.id
      LEFT JOIN LATERAL (
        SELECT (SELECT u.email FROM public.users u WHERE u.id = st.approver_id) AS email
          FROM public.approval_steps st
         WHERE st.submission_id = p.current_submission_id AND st.status = 'APPROVED'
         ORDER BY st.level DESC
         LIMIT 1
      ) fa ON true
     ORDER BY p.approved_at, p.id`;
}

/**
 * One export batch: at most `limit` APPROVED claims with approved_at in [gte, lt) and before asOf,
 * strictly after the cursor, in (approved_at, id) order. FINANCE only (the service checked first;
 * this refuses again before any SQL runs). The snapshot JSON is parsed against C-21, so a stored
 * row that drifted from the contract fails the stream instead of exporting a different shape.
 */
export async function approvedClaimsBatch(
  actor: Actor,
  a: ApprovedClaimsBatchArgs,
): Promise<ExportClaimRow[]> {
  requireRole(actor, 'FINANCE');
  const rows = await getDb().$queryRaw<BatchRow[]>(approvedClaimsBatchSql(a));
  return rows.map((r) => ({
    id: r.id,
    claimNumber: r.claimNumber,
    revision: Number(r.revision),
    approvedAt: r.approvedAt,
    submittedAt: r.submittedAt,
    finalApproverEmail: r.finalApproverEmail,
    snapshot: SnapshotV1.parse(r.snapshot),
  }));
}
