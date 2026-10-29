import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { todayInBusinessTz } from '@/shared/dates';
import type { ApprovalTask } from '@/shared/dto/approvals';
import type { CategoryDto } from '@/shared/dto/categories';
import type { ClaimDetail } from '@/shared/dto/claims';

/**
 * Public-API helpers for the journeys (05 §15.3). Each takes the persona's APIRequestContext,
 * whose cookie jar is that persona's session; it sends no Origin header, which the CSRF rule
 * allows. Specs never reset the database, so every claim gets a unique title.
 */

/** "E2E <label> <time>-<random>": unique across reruns against the same database. */
export const uniqueTitle = (label: string): string =>
  `E2E ${label} ${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

/** The status must match; the message carries the body so a failure says why. */
export async function expectStatus(res: APIResponse, status: number): Promise<void> {
  const where = new URL(res.url()).pathname;
  expect(res.status(), `${where} → ${res.status()} ${await res.text()}`).toBe(status);
}

/** A refusal: the status and the stable error code from the C-08 envelope. */
export async function expectError(res: APIResponse, status: number, code: string): Promise<void> {
  await expectStatus(res, status);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe(code);
}

async function data<T>(res: APIResponse, status = 200): Promise<T> {
  await expectStatus(res, status);
  return ((await res.json()) as { data: T }).data;
}

export async function categoryId(api: APIRequestContext, code: string): Promise<string> {
  const cats = await data<CategoryDto[]>(await api.get('/api/v1/categories'));
  const cat = cats.find((c) => c.code === code && c.isActive);
  if (!cat) throw new Error(`No active category ${code}`);
  return cat.id;
}

export interface LineSpec {
  /** Category code, e.g. LODGING or MEALS. */
  category: string;
  amountMinor: number;
  description: string;
}

/** POST /claims: a DRAFT with these lines, each dated today in IST (runs near midnight pass). */
export async function createDraft(
  api: APIRequestContext,
  title: string,
  lines: readonly LineSpec[],
): Promise<ClaimDetail> {
  const expenseDate = todayInBusinessTz();
  const lineItems = await Promise.all(
    lines.map(async (l) => ({
      expenseDate,
      categoryId: await categoryId(api, l.category),
      amountMinor: l.amountMinor,
      description: l.description,
    })),
  );
  return data<ClaimDetail>(await api.post('/api/v1/claims', { data: { title, lineItems } }), 201);
}

export async function submit(api: APIRequestContext, claimId: string): Promise<ClaimDetail> {
  return data<ClaimDetail>(await api.post(`/api/v1/claims/${claimId}/submit`, { data: {} }));
}

export async function createAndSubmit(
  api: APIRequestContext,
  title: string,
  lines: readonly LineSpec[],
): Promise<ClaimDetail> {
  const draft = await createDraft(api, title, lines);
  return submit(api, draft.id);
}

export async function getClaim(api: APIRequestContext, claimId: string): Promise<ClaimDetail> {
  return data<ClaimDetail>(await api.get(`/api/v1/claims/${claimId}`));
}

export async function approve(
  api: APIRequestContext,
  claimId: string,
  revision: number,
): Promise<ClaimDetail> {
  return data<ClaimDetail>(
    await api.post(`/api/v1/claims/${claimId}/approve`, { data: { revision } }),
  );
}

/**
 * Tidy-up: the claimant recalls a claim the test left in approval, so reruns don't grow the
 * shared queues. Only while it is still SUBMITTED (a failed run may have left it elsewhere).
 */
export async function recallIfInApproval(api: APIRequestContext, claimId: string): Promise<void> {
  const claim = await getClaim(api, claimId);
  if (!claim.allowedActions.includes('RECALL')) return;
  await expectStatus(
    await api.post(`/api/v1/claims/${claimId}/recall`, { data: { note: 'E2E tidy-up' } }),
    200,
  );
}

/** Every PENDING task in this approver's queue, all pages (GET /approvals is keyset-paged). */
export async function pendingQueue(api: APIRequestContext): Promise<ApprovalTask[]> {
  const tasks: ApprovalTask[] = [];
  let cursor: string | null = null;
  do {
    const params: Record<string, string> = { limit: '100' };
    if (cursor) params.cursor = cursor;
    const res = await api.get('/api/v1/approvals', { params });
    await expectStatus(res, 200);
    const body = (await res.json()) as {
      data: ApprovalTask[];
      page: { nextCursor: string | null };
    };
    tasks.push(...body.data);
    cursor = body.page.nextCursor;
  } while (cursor);
  return tasks;
}

export async function isInPendingQueue(api: APIRequestContext, claimId: string): Promise<boolean> {
  return (await pendingQueue(api)).some((t) => t.claimId === claimId);
}
