// Test data factories (07 §5.3). The file grows with the phases: P1 needs only makeUser (TC-I01,
// TC-I02 mutate users); P2 adds makeDraft, categoryIds and lineInput, P3 submitAs, P4 approveAs,
// rejectAs and ownerDecideAt, P5 recallAs, P6 fakePdf, pdfForm and the `receipt` option of makeDraft.
// Claims are built through the real services, never raw SQL, so fixtures obey every rule the app
// does; only users (which expense_app can't write) and backdated rows use owner SQL.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/server/auth/actor';
import type { ServiceCtx } from '@/server/services/context';
import * as approvalsService from '@/server/services/approvals.service';
import * as claimsService from '@/server/services/claims.service';
import * as lifecycleService from '@/server/services/lifecycle.service';
import * as receiptsService from '@/server/services/receipts.service';
import { MemoryReceiptStorage } from '@/server/storage/memory-receipt-storage';
import { getStorage } from '@/server/storage/receipt-storage';
import { todayInBusinessTz } from '@/shared/dates';
import type { ClaimDetail } from '@/shared/dto/claims';
import type { UserRole } from '@/shared/enums';
import type { LineItemInput } from '@/shared/schemas/claims';
import { asPersona, emailOf, type Persona } from './auth';
import { appSql, ownerClient, ownerSql } from './db';
import { rawDecide } from './raw-submit';

export type { ClaimDetail };

/** One line of a fixture claim; everything but the amount has a valid default. */
export interface LineSpec {
  amountMinor: number;
  /** A category code (default MEALS). */
  category?: string;
  expenseDate?: string;
  description?: string;
  merchant?: string;
  /** P6: uploaded to this line through the real receipts service (e.g. `fakePdf()`). */
  receipt?: File;
}

/** Every service function is (ctx, ...ids, input?) (C-26); the request id matches REQUEST_ID_PATTERN. */
export const ctx = (actor: Actor): ServiceCtx => ({ actor, requestId: `test-${randomUUID()}` });

let categoryCache: Record<string, string> | undefined;
/** `{ MEALS: uuid, … }` from the seeded categories (ids never change during a run). */
export async function categoryIds(): Promise<Record<string, string>> {
  categoryCache ??= Object.fromEntries(
    (await appSql<{ code: string; id: string }>`SELECT code, id FROM categories`).map((r) => [
      r.code,
      r.id,
    ]),
  );
  return categoryCache;
}

/**
 * A throwaway `tmp.*@acme.test` user for anything that mutates a user (deactivate, demote to
 * FINANCE, re-point a manager). expense_app can't INSERT users, so this is owner SQL; resetDb()
 * deletes every tmp.* user before the next test.
 */
export async function makeUser(
  o: { role?: UserRole; canApprove?: boolean; manager?: Persona } = {},
): Promise<{ id: string; email: string }> {
  const email = `tmp.${randomUUID().slice(0, 8)}@acme.test`;
  const [u] = await ownerSql<{ id: string; email: string }>`
    INSERT INTO users (employee_code, email, name, role, can_approve, department_id, manager_id)
    VALUES (${'T' + email.slice(4, 12)}, ${email}, 'Temp User', ${o.role ?? 'EMPLOYEE'}::user_role,
            ${o.canApprove ?? false}, (SELECT id FROM departments WHERE code = 'ENG'),
            (SELECT id FROM users WHERE email = ${emailOf(o.manager ?? 'ravi')}))
    RETURNING id, email`;
  return u!;
}

/** A DRAFT through createClaim, then (if `lines`) one replaceClaim; returns the fresh detail. */
export async function makeDraft(
  who: Persona | Actor,
  o: { title?: string; lines?: LineSpec[] } = {},
): Promise<ClaimDetail> {
  const actor = typeof who === 'string' ? await asPersona(who) : who;
  const claim = await claimsService.createClaim(ctx(actor), {
    title: o.title ?? `Test claim ${randomUUID().slice(0, 6)}`,
  });
  if (o.lines?.length) {
    const cats = await categoryIds();
    const filled = await claimsService.replaceClaim(ctx(actor), claim.id, {
      title: claim.title,
      lineItems: o.lines.map((l) => ({
        expenseDate: l.expenseDate ?? todayInBusinessTz(),
        categoryId: cats[l.category ?? 'MEALS']!,
        amountMinor: l.amountMinor,
        description: l.description ?? 'Test expense',
        merchant: l.merchant,
      })),
    });
    // The detail lists lines by (expense_date, id); the ids are uuidv7 from ONE multi-row INSERT
    // in input order, so sorting by id maps spec i to the line it created.
    const created = [...filled.lineItems].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const [i, l] of o.lines.entries())
      if (l.receipt) await receiptsService.upload(ctx(actor), claim.id, created[i]!.id, l.receipt);
  }
  return claimsService.getClaim(ctx(actor), claim.id);
}

/**
 * Submits (or, from REJECTED, resubmits) the claim as `who` through the real service: the chain is
 * built from the DB total, and the fresh ClaimDetail (SUBMITTED, revision + 1, approval) returns.
 */
export const submitAs = async (who: Persona | Actor, c: Pick<ClaimDetail, 'id'>) =>
  lifecycleService.submit(ctx(typeof who === 'string' ? await asPersona(who) : who), c.id, {});

/** A detail line back as PUT input, keeping its id (an update, not delete + insert). */
export const lineInput = (l: ClaimDetail['lineItems'][number]): LineItemInput => ({
  id: l.id,
  expenseDate: l.expenseDate,
  categoryId: l.category.id,
  amountMinor: l.amountMinor,
  description: l.description,
  merchant: l.merchant ?? undefined,
});

const actorOf = async (who: Persona | Actor): Promise<Actor> =>
  typeof who === 'string' ? asPersona(who) : who;

/**
 * Approves `who`'s PENDING step through the real service with the claim's current revision, and
 * returns the fresh detail. With `at` it is ownerDecideAt instead: the only decision fixture that
 * bypasses the services, because only the owner may supply transition timestamps (D-23).
 */
export async function approveAs(
  who: Persona | Actor,
  c: Pick<ClaimDetail, 'id' | 'currentRevision'>,
  o: { at?: string; comment?: string } = {},
): Promise<ClaimDetail> {
  if (o.at) return ownerDecideAt(who, c, 'APPROVED', o.at);
  return approvalsService.approve(ctx(await actorOf(who)), c.id, {
    revision: c.currentRevision,
    ...(o.comment !== undefined && { comment: o.comment }),
  });
}

/** Rejects `who`'s PENDING step through the real service (default reason: C05's). */
export const rejectAs = async (
  who: Persona | Actor,
  c: Pick<ClaimDetail, 'id' | 'currentRevision'>,
  reason = 'Hotel invoice missing for 3 Oct',
): Promise<ClaimDetail> =>
  approvalsService.reject(ctx(await actorOf(who)), c.id, {
    revision: c.currentRevision,
    reason,
  });

/**
 * Recalls the claim as `who` (its owner) through the real service (02 §9.4): the open steps of the
 * current revision are CANCELLED, approved ones stay, the claim is a DRAFT again and one
 * CLAIM_RECALLED event is written. Returns the fresh detail. No clock and no revision: recall
 * needs neither.
 */
export const recallAs = async (
  who: Persona | Actor,
  c: Pick<ClaimDetail, 'id'>,
  note?: string,
): Promise<ClaimDetail> =>
  lifecycleService.recall(ctx(await actorOf(who)), c.id, note === undefined ? {} : { note });

/**
 * A backdated decision (07 §5.3): owner SQL running the C-25 approve/reject order with
 * decided_at = approved_at / rejected_at = occurred_at = `at` (plus the next level's activated_at
 * on a non-final approval, and cancelled_at of the later WAITING steps on a rejection). Every
 * trigger still checks it, including the deferred UC015 audit check. Returns the fresh detail as
 * `who` sees it (a decided approver keeps read access).
 */
export async function ownerDecideAt(
  who: Persona | Actor,
  c: Pick<ClaimDetail, 'id'>,
  outcome: 'APPROVED' | 'REJECTED',
  at: string,
): Promise<ClaimDetail> {
  const actor = await actorOf(who);
  await rawDecide(await ownerClient(), c.id, { approverId: actor.id, outcome, at });
  return claimsService.getClaim(ctx(actor), c.id);
}

/**
 * An in-memory PDF of exactly `bytes` bytes: the `%PDF-1.7` magic, then zero padding (07 §5.3).
 * `fakePdf(10_380_902)` is the 9.9 MiB case, `fakePdf(10_485_761)` is 10 MiB + 1 byte.
 */
export const fakePdf = (bytes = 2_048, name = 'invoice.pdf'): File =>
  new File([Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(bytes - 9)])], name, {
    type: 'application/pdf',
  });

/** The multipart body of a receipt upload: the one field `file`. */
export const pdfForm = (f: File = fakePdf()): FormData => {
  const fd = new FormData();
  fd.set('file', f);
  return fd;
};

/**
 * The receipt store the app is using in this test: integration-setup.ts selects the memory driver,
 * and resetDb() empties it (and clears its faults and onPut hook) before every test.
 */
export function memoryStorage(): MemoryReceiptStorage {
  const storage = getStorage();
  if (!(storage instanceof MemoryReceiptStorage))
    throw new Error('integration tests run with RECEIPT_STORAGE_DRIVER=memory');
  return storage;
}
