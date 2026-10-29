import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import { financeClaimsWhere } from '@/server/repositories/claim-visibility';
import { CLAIM_STATUSES, type ClaimStatus } from '@/shared/enums';
import type { FinanceDateField } from '@/shared/schemas/queries';

// The finance list (04 §5.4, §8.3; 06 §7). One hand-written statement per page (06 §7 rule 5): the
// line count is a correlated count on line_items_claim_idx and the claimant a PK join, both
// evaluated only for the rows the LIMIT lets through. (Prisma's `_count` would aggregate the whole
// line_items table on every page, and its relation load is a second query.)

export interface FinanceListRow {
  id: string;
  claimNumber: string;
  title: string;
  status: ClaimStatus;
  currency: string;
  totalMinor: number;
  currentRevision: number;
  lineItemCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  claimantId: string;
  claimantName: string;
  claimantEmail: string;
}

export interface FinanceListArgs {
  statuses: readonly ClaimStatus[];
  /** The sort column, and the column `range` filters. */
  dateField: FinanceDateField;
  /** Half-open UTC range on `dateField` (from businessDayRangeToUtc). */
  range: { gte?: Date; lt?: Date };
  /** Keyset position: rows strictly after (value, id) in `DESC NULLS FIRST` order. */
  after?: { value: Date | null; id: string };
  /** limit + 1, so the caller can tell whether another page exists. */
  take: number;
}

const COLUMN: Readonly<Record<FinanceDateField, Prisma.Sql>> = {
  submittedAt: Prisma.sql`c.submitted_at`,
  approvedAt: Prisma.sql`c.approved_at`,
};

// Instants travel as ISO strings with an explicit cast: no dependence on the session TimeZone.
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamptz`;

/**
 * The page SQL (exported for the EXPLAIN capture, which must run the app's exact statement).
 * Scope first: `financeClaimsWhere(actor)` (FORBIDDEN unless FINANCE). Fixed sort
 * `<col> DESC, id DESC` with Postgres' default NULLS FIRST, matching an index exactly, so there is
 * no Sort node at any depth:
 * - default statuses: claims_submitted_idx (submitted_at DESC, id DESC), status as a Filter;
 * - one status: claims_finance_list_idx (status, submitted_at DESC, id DESC);
 * - dateField=approvedAt: claims_export_idx (approved_at, id), scanned backward.
 * `<col> IS NOT NULL` is stated whenever NULLs aren't wanted (rule 4: the planner doesn't prune
 * index ranges with CHECKs). Only never-submitted drafts have a NULL submitted_at, so NULLs are
 * wanted only for dateField=submittedAt with DRAFT listed; they come first, and a NULL cursor
 * continues with `(col IS NULL AND id < cursor.id) OR col IS NOT NULL` (04 §8.2). A NULL
 * approved_at means "not approved", so dateField=approvedAt lists approved claims only.
 */
export function financeListSql(actor: Actor, a: FinanceListArgs): Prisma.Sql {
  const col = COLUMN[a.dateField];
  const where: Prisma.Sql[] = [financeClaimsWhere(actor)];
  const statuses = [...new Set(a.statuses)];
  if (a.dateField === 'approvedAt') {
    // CHECK claims_approved_at_iff_approved: approved_at IS NOT NULL ⇔ status = 'APPROVED'. So the
    // status list either admits every row with an approved_at or none, and leaving status out of
    // the WHERE keeps claims_export_idx (backward) the only sensible plan.
    if (!statuses.includes('APPROVED')) where.push(Prisma.sql`FALSE`);
  } else if (statuses.length === 1) {
    where.push(Prisma.sql`c.status = ${statuses[0]}::public.claim_status`);
  } else if (statuses.length < CLAIM_STATUSES.length) {
    const list = statuses.map((s) => Prisma.sql`${s}::public.claim_status`);
    where.push(Prisma.sql`c.status IN (${Prisma.join(list)})`);
  }
  const nullsWanted = a.dateField === 'submittedAt' && statuses.includes('DRAFT');
  if (!nullsWanted) where.push(Prisma.sql`${col} IS NOT NULL`);
  if (a.range.gte) where.push(Prisma.sql`${col} >= ${ts(a.range.gte)}`);
  if (a.range.lt) where.push(Prisma.sql`${col} < ${ts(a.range.lt)}`);
  if (a.after)
    where.push(
      a.after.value === null
        ? Prisma.sql`((${col} IS NULL AND c.id < ${a.after.id}::uuid) OR ${col} IS NOT NULL)`
        : Prisma.sql`(${col}, c.id) < (${ts(a.after.value)}, ${a.after.id}::uuid)`,
    );
  return Prisma.sql`
    SELECT c.id, c.claim_number AS "claimNumber", c.title, c.status::text AS status, c.currency,
           c.total_minor AS "totalMinor", c.current_revision AS "currentRevision",
           (SELECT count(*)::int FROM public.line_items li WHERE li.claim_id = c.id)
             AS "lineItemCount",
           c.created_at AS "createdAt", c.submitted_at AS "submittedAt",
           c.approved_at AS "approvedAt",
           u.id AS "claimantId", u.name AS "claimantName", u.email AS "claimantEmail"
      FROM public.claims c
      JOIN public.users u ON u.id = c.claimant_id
     WHERE ${Prisma.join(where, ' AND ')}
     ORDER BY ${col} DESC, c.id DESC
     LIMIT ${a.take}`;
}

/** GET /api/v1/finance/claims: one keyset page of every claimant's claims (see financeListSql). */
export function listForFinance(actor: Actor, a: FinanceListArgs): Promise<FinanceListRow[]> {
  return getDb().$queryRaw<FinanceListRow[]>(financeListSql(actor, a));
}
