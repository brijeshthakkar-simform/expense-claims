import 'server-only';
import { assertOk, decide, type ClaimFacts } from '@/server/authz/claim-policy';
import { withTx, type Tx } from '@/server/db/tx';
import { AppError } from '@/server/errors/app-error';
import { logEvent } from '@/server/logging/logger';
import * as categoriesRepo from '@/server/repositories/categories.repo';
import { findClaimForActor } from '@/server/repositories/claim-visibility';
import * as claimsRepo from '@/server/repositories/claims.repo';
import { expectCount, expectOne, type LockedClaim } from '@/server/repositories/claims.repo';
import * as lineItemsRepo from '@/server/repositories/line-items.repo';
import type { LineItemRow, LineItemWrite } from '@/server/repositories/line-items.repo';
import * as receiptsRepo from '@/server/repositories/receipts.repo';
import { toClaimDetail, toClaimHistory, toClaimSummary } from '@/server/services/claim-dto';
import type { ServiceCtx } from '@/server/services/context';
import { discardObjects } from '@/server/services/receipts.service';
import { CursorError, decodeCursor, encodeCursor, type CursorFilters } from '@/shared/cursor';
import { businessDayRangeToUtc } from '@/shared/dates';
import type { ClaimDetail, ClaimSummary } from '@/shared/dto/claims';
import type { ClaimHistory } from '@/shared/dto/history';
import type { ApiIssue } from '@/shared/errors';
import type {
  CreateClaimInput,
  NewLineItemInput,
  ReplaceClaimInput,
} from '@/shared/schemas/claims';
import type { ClaimListQuery } from '@/shared/schemas/queries';

// Draft claims (C-25, C-26). Every function is (ctx, ...ids, input?). Mutations run in withTx with
// the actor-scoped claim lock first, decide under the lock, write with count-checked statements,
// commit, log, then return the fresh ClaimDetail re-read through findClaimForActor. No code here
// computes or writes a total: Postgres derives claims.total_minor from the lines (03 §4).

const factsOf = (c: LockedClaim): ClaimFacts => ({
  status: c.status,
  claimantId: c.claimantId,
  currentRevision: c.currentRevision,
  myStepOnCurrentRevision: null, // owner actions never depend on an approval step
});

const toWrite = (l: NewLineItemInput): LineItemWrite => ({
  categoryId: l.categoryId,
  expenseDate: l.expenseDate,
  amountMinor: l.amountMinor,
  description: l.description,
  merchant: l.merchant || null, // '' and absent are both "no merchant"
});

const sameLine = (a: LineItemWrite, b: LineItemWrite) =>
  a.categoryId === b.categoryId &&
  a.expenseDate === b.expenseDate &&
  a.amountMinor === b.amountMinor &&
  a.description === b.description &&
  a.merchant === b.merchant;

/**
 * Category existence and activity, with issue paths the form can map (04 §10.3). Unknown → 422
 * VALIDATION_FAILED at lineItems.N.categoryId; retired → 422 CATEGORY_INACTIVE, but only for a new
 * line or a changed category (a kept line may keep its retired category, exactly like the UC013
 * trigger). Runs before any line write, so a refusal changes nothing.
 */
async function assertCategoriesUsable(
  tx: Tx,
  lines: readonly { id?: string; categoryId: string }[],
  existing: ReadonlyMap<string, LineItemRow>,
): Promise<void> {
  const found = new Map(
    (
      await categoriesRepo.findCategoriesByIds(tx, [...new Set(lines.map((l) => l.categoryId))])
    ).map((c) => [c.id, c.isActive]),
  );
  const issuesWhere = (bad: (l: (typeof lines)[number]) => boolean, message: string) =>
    lines.flatMap((l, i): ApiIssue[] =>
      bad(l) ? [{ path: ['lineItems', i, 'categoryId'], message, code: 'custom' }] : [],
    );

  const unknown = issuesWhere((l) => !found.has(l.categoryId), 'Choose a valid category');
  if (unknown.length) throw new AppError('VALIDATION_FAILED', undefined, { issues: unknown });

  const retired = issuesWhere(
    (l) =>
      found.get(l.categoryId) === false &&
      (l.id === undefined || existing.get(l.id)?.categoryId !== l.categoryId),
    'This category is no longer available',
  );
  if (retired.length) throw new AppError('CATEGORY_INACTIVE', undefined, { issues: retired });
}

/** POST /api/v1/claims: an empty DRAFT owned by the caller, then its first lines (if any). */
export async function createClaim(ctx: ServiceCtx, input: CreateClaimInput): Promise<ClaimDetail> {
  const { actor } = ctx;
  const lines = (input.lineItems ?? []).map(toWrite);
  const at = ctx.clock?.now(); // owner-run seed only; the DB re-stamps created_at for expense_app
  const claimId = await withTx(async (tx) => {
    // Checked first, so a refused body doesn't even draw a claim number.
    await assertCategoriesUsable(tx, input.lineItems ?? [], new Map());
    const { id } = await claimsRepo.insertDraft(tx, actor, { title: input.title, createdAt: at });
    expectCount(await lineItemsRepo.insertLines(tx, actor, id, lines, at), lines.length);
    return id;
  });
  logEvent('claim.created', { claimId, lineItemCount: lines.length });
  return getClaim(ctx, claimId);
}

/** GET /api/v1/claims/:claimId: one scoped SELECT; not visible = 404, same as a random id. */
export async function getClaim(ctx: ServiceCtx, claimId: string): Promise<ClaimDetail> {
  const row = await findClaimForActor(ctx.actor, claimId, claimsRepo.CLAIM_DETAIL_SELECT);
  if (!row) throw new AppError('CLAIM_NOT_FOUND');
  return toClaimDetail(ctx.actor, row);
}

/**
 * GET /api/v1/claims/:claimId/history: every revision (snapshot, derived outcome, chain) and every
 * event in (occurredAt, id) order. The same scoped SELECT as getClaim, so whoever can't see the
 * claim gets the same 404 as for a random id (a WAITING or CANCELLED approver included).
 */
export async function getClaimHistory(ctx: ServiceCtx, claimId: string): Promise<ClaimHistory> {
  const row = await findClaimForActor(ctx.actor, claimId, claimsRepo.CLAIM_HISTORY_SELECT);
  if (!row) throw new AppError('CLAIM_NOT_FOUND');
  return toClaimHistory(row);
}

/**
 * PUT /api/v1/claims/:claimId: replace title + the whole line set, in the C-25 write order: lock
 * my claim → status (409) → existing ids, where a foreign id is 404 LINE_ITEM_NOT_FOUND before
 * anything is written → categories (422) → collect the receipt keys of the removed lines →
 * delete removed lines (their receipts cascade) → update changed kept lines (WHERE id AND
 * claim_id, count 1) → insert new lines (claim_id from the PATH) → title. One transaction: all of
 * it or none of it. After commit, D-31: the removed objects are deleted only if the claim was never
 * submitted (current_revision = 0); otherwise a snapshot may reference them and they stay.
 */
export async function replaceClaim(
  ctx: ServiceCtx,
  claimId: string,
  input: ReplaceClaimInput,
): Promise<ClaimDetail> {
  const { actor } = ctx;
  const at = ctx.clock?.now(); // owner-run seed only: backdates the line/claim updated_at
  const done = await withTx(async (tx) => {
    const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
    if (!claim) throw new AppError('CLAIM_NOT_FOUND'); // not mine (incl. FINANCE) or no such claim
    assertOk(decide(actor, factsOf(claim)).EDIT); // 409 CLAIM_LOCKED / CLAIM_NOT_EDITABLE

    const existing = new Map(
      (await lineItemsRepo.listForClaim(tx, actor, claimId)).map((l) => [l.id, l]),
    );
    if (input.lineItems.some((l) => l.id !== undefined && !existing.has(l.id)))
      throw new AppError('LINE_ITEM_NOT_FOUND'); // RT-B2: another claim's line rides in my PUT
    await assertCategoriesUsable(tx, input.lineItems, existing);

    const keptIds = new Set(input.lineItems.flatMap((l) => (l.id ? [l.id] : [])));
    const removed = [...existing.keys()].filter((id) => !keptIds.has(id));
    const removedKeys = await receiptsRepo.storageKeysForLines(tx, actor, claimId, removed);
    if (removed.length)
      expectCount(await lineItemsRepo.deleteLines(tx, actor, claimId, removed), removed.length);

    // Decreases before increases: the total then moves monotonically towards its final value, so
    // no intermediate statement can trip the claim cap (claims_total_range) or int4 overflow.
    const updates = input.lineItems
      .flatMap((l) => {
        const before = l.id === undefined ? undefined : existing.get(l.id);
        const after = toWrite(l);
        return before && !sameLine(before, after) ? [{ id: before.id, before, after }] : [];
      })
      .sort(
        (a, b) =>
          a.after.amountMinor - a.before.amountMinor - (b.after.amountMinor - b.before.amountMinor),
      );
    for (const u of updates)
      expectOne(await lineItemsRepo.updateLine(tx, actor, claimId, u.id, u.after, at));

    const inserts = input.lineItems.filter((l) => l.id === undefined).map(toWrite);
    expectCount(await lineItemsRepo.insertLines(tx, actor, claimId, inserts, at), inserts.length);

    if (input.title !== claim.title)
      expectOne(await claimsRepo.updateTitle(tx, actor, claimId, input.title, at));
    return {
      stats: { deleted: removed.length, updated: updates.length, inserted: inserts.length },
      removedKeys,
      neverSubmitted: claim.currentRevision === 0,
    };
  });
  if (done.neverSubmitted && done.removedKeys.length)
    await discardObjects(done.removedKeys, { claimId, reason: 'line_removed' });
  logEvent('claim.updated', { claimId, lineItemCount: input.lineItems.length, ...done.stats });
  return getClaim(ctx, claimId);
}

/**
 * DELETE /api/v1/claims/:claimId (C-25): only a never-submitted DRAFT of mine (current_revision =
 * 0); otherwise 409 CLAIM_HAS_HISTORY (or CLAIM_LOCKED). Collect the receipt keys under the lock,
 * DELETE the claim (lines and receipts cascade), then after commit delete the objects (D-31; a
 * failure is logged as receipt.object_orphaned).
 */
export async function deleteDraft(ctx: ServiceCtx, claimId: string): Promise<void> {
  const { actor } = ctx;
  const keys = await withTx(async (tx) => {
    const claim = await claimsRepo.lockOwnedClaim(tx, actor, claimId);
    if (!claim) throw new AppError('CLAIM_NOT_FOUND');
    assertOk(decide(actor, factsOf(claim)).DELETE); // implies current_revision = 0
    const storageKeys = await receiptsRepo.storageKeysForClaim(tx, actor, claimId);
    expectOne(await claimsRepo.deleteOwnedClaim(tx, actor, claimId));
    return storageKeys;
  });
  if (keys.length) await discardObjects(keys, { claimId, reason: 'draft_deleted' });
  logEvent('claim.deleted', { claimId, receiptObjects: keys.length });
}

// ------------------------------------------------------------------------------------- list

/** The fixed sort of GET /claims, bound into every cursor it issues. */
export const MY_CLAIMS_SORT = 'createdAt:desc';

export interface ClaimPage {
  items: ClaimSummary[];
  nextCursor: string | null;
  limit: number;
}

/** GET /api/v1/claims: my claims, newest first, keyset-paginated (C-09). */
export async function listMyClaims(ctx: ServiceCtx, query: ClaimListQuery): Promise<ClaimPage> {
  const filters: CursorFilters = { status: query.status, from: query.from, to: query.to };
  const rows = await claimsRepo.listMine(ctx.actor, {
    statuses: query.status,
    createdAt: businessDayRangeToUtc(query.from, query.to),
    after: query.cursor === undefined ? undefined : readCursor(query.cursor, filters),
    take: query.limit + 1, // one extra row says whether there is a next page
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? encodeCursor(MY_CLAIMS_SORT, { value: last.createdAt.toISOString(), id: last.id }, filters)
      : null;
  return { items: page.map(toClaimSummary), nextCursor, limit: query.limit };
}

function readCursor(raw: string, filters: CursorFilters): { createdAt: Date; id: string } {
  try {
    const pos = decodeCursor(raw, MY_CLAIMS_SORT, filters);
    if (pos.value === null) throw new CursorError('created_at is never null');
    return { createdAt: new Date(pos.value), id: pos.id };
  } catch (err) {
    if (err instanceof CursorError) throw new AppError('INVALID_CURSOR');
    throw err;
  }
}
