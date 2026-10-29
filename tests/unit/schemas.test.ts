// TC-U05 (§3.1-c, §6-1, §6-2, RT-m4): the shared request schemas are strict. A total-like key is
// 422 TOTAL_IS_DERIVED, another server-owned key 422 READ_ONLY_FIELD, any other unknown key 422
// VALIDATION_FAILED; nothing is ever stripped (04 §10). The codes come from mapError, the same
// mapper defineRoute uses.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { mapError } from '@/server/errors/map-error';
import { todayInBusinessTz } from '@/shared/dates';
import {
  AmountMinorSchema,
  CreateClaimInput,
  RejectInput,
  RejectReasonSchema,
  ReplaceClaimInput,
} from '@/shared/schemas/claims';
import { ClaimListQuery } from '@/shared/schemas/queries';

const CATEGORY = '0199c0de-0000-7000-8000-000000000001';
const LINE_ID = '0199c0de-0000-7000-8000-0000000000aa';
const line = (o: Record<string, unknown> = {}) => ({
  expenseDate: todayInBusinessTz(),
  categoryId: CATEGORY,
  amountMinor: 45_000,
  description: 'Team lunch',
  ...o,
});
const createBody = (o: Record<string, unknown> = {}) => ({ title: 'Client visit', ...o });
const replaceBody = (o: Record<string, unknown> = {}) => ({
  title: 'Client visit',
  lineItems: [line({ id: LINE_ID })],
  ...o,
});

/** What defineRoute would answer for this input: the mapped code and issue paths. */
function refusal(schema: z.ZodType, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) return { code: 'ACCEPTED' as const, paths: [] };
  const e = mapError(r.error);
  const issues = (e.details?.issues ?? []) as { path: (string | number)[] }[];
  return { code: e.code, status: e.status, paths: issues.map((i) => i.path) };
}

describe('TC-U05 schemas', () => {
  it('claim bodies containing totalMinor fail with TOTAL_IS_DERIVED', () => {
    for (const key of ['totalMinor', 'total', 'total_minor']) {
      expect(refusal(CreateClaimInput, createBody({ [key]: 1 }))).toEqual({
        code: 'TOTAL_IS_DERIVED',
        status: 422,
        paths: [[key]],
      });
      expect(refusal(ReplaceClaimInput, replaceBody({ [key]: 0 })).code).toBe('TOTAL_IS_DERIVED');
    }
    // the total-like key wins over other server-owned keys, and is caught inside a line too
    expect(
      refusal(ReplaceClaimInput, replaceBody({ status: 'APPROVED', totalMinor: 1 })).code,
    ).toBe('TOTAL_IS_DERIVED');
    expect(
      refusal(ReplaceClaimInput, replaceBody({ lineItems: [line({ totalMinor: 5 })] })),
    ).toMatchObject({ code: 'TOTAL_IS_DERIVED', paths: [['lineItems', 0, 'totalMinor']] });
  });

  it('claim bodies containing status, claimantId or claimNumber fail with READ_ONLY_FIELD', () => {
    for (const [key, value] of [
      ['status', 'APPROVED'],
      ['claimantId', '0199c0de-0000-7000-8000-0000000000ff'],
      ['claimNumber', 'EXP-2026-000001'],
      ['currentRevision', 3],
      ['approvedAt', '2026-10-01T00:00:00.000Z'],
      ['allowedActions', ['APPROVE']],
    ] as const) {
      for (const [schema, body] of [
        [CreateClaimInput, createBody({ [key]: value })],
        [ReplaceClaimInput, replaceBody({ [key]: value })],
      ] as const)
        expect([key, refusal(schema, body)]).toEqual([
          key,
          { code: 'READ_ONLY_FIELD', status: 422, paths: [[key]] },
        ]);
    }
    // line level: claimId and receipts always, id on create (POST lines are always new)
    expect(
      refusal(CreateClaimInput, createBody({ lineItems: [line({ id: LINE_ID })] })),
    ).toMatchObject({ code: 'READ_ONLY_FIELD', paths: [['lineItems', 0, 'id']] });
    expect(
      refusal(ReplaceClaimInput, replaceBody({ lineItems: [line({ claimId: LINE_ID })] })),
    ).toMatchObject({ code: 'READ_ONLY_FIELD', paths: [['lineItems', 0, 'claimId']] });
    expect(
      refusal(ReplaceClaimInput, replaceBody({ lineItems: [line({ receipts: [] })] })).code,
    ).toBe('READ_ONLY_FIELD');
  });

  it('amountMinor must be a positive safe integer ≤ 100000000', () => {
    for (const ok of [1, 45_000, 100_000_000])
      expect([ok, AmountMinorSchema.safeParse(ok).success]).toEqual([ok, true]);
    for (const bad of [
      0,
      -1,
      1.5,
      0.29,
      100_000_001,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '450',
      null,
    ])
      expect([bad, AmountMinorSchema.safeParse(bad).success]).toEqual([bad, false]);
    // inside a body, the failure lands on the exact field
    expect(
      refusal(ReplaceClaimInput, replaceBody({ lineItems: [line(), line({ amountMinor: 0 })] })),
    ).toEqual({ code: 'VALIDATION_FAILED', status: 422, paths: [['lineItems', 1, 'amountMinor']] });
  });

  it('unknown keys are rejected, never stripped', () => {
    expect(refusal(CreateClaimInput, createBody({ notes: 'hi' }))).toEqual({
      code: 'VALIDATION_FAILED',
      status: 422,
      paths: [[]], // unrecognized_keys sits on the object; the key is named in the message
    });
    expect(
      refusal(ReplaceClaimInput, replaceBody({ lineItems: [line({ vendorGst: 'X' })] })),
    ).toEqual({ code: 'VALIDATION_FAILED', status: 422, paths: [['lineItems', 0]] });
    const issue = CreateClaimInput.safeParse(createBody({ notes: 'hi' })).error?.issues[0];
    expect(issue).toMatchObject({ code: 'unrecognized_keys', keys: ['notes'] });
    // a clean body parses to exactly its own keys (trimmed), nothing added and nothing dropped
    expect(ReplaceClaimInput.parse(replaceBody({ title: '  Client visit  ' }))).toEqual({
      title: 'Client visit',
      lineItems: [line({ id: LINE_ID })],
    });
  });

  it('reject reason is trimmed and must be 10..1000 characters', () => {
    expect(RejectReasonSchema.parse('   Hotel invoice missing   ')).toBe('Hotel invoice missing');
    expect(RejectReasonSchema.safeParse('a'.repeat(10)).success).toBe(true);
    expect(RejectReasonSchema.safeParse('a'.repeat(1000)).success).toBe(true);
    expect(RejectReasonSchema.safeParse('a'.repeat(9)).success).toBe(false);
    expect(RejectReasonSchema.safeParse(`  ${'a'.repeat(9)}      `).success).toBe(false); // 9 after trim
    expect(RejectReasonSchema.safeParse('a'.repeat(1001)).success).toBe(false);
    expect(RejectReasonSchema.safeParse(' '.repeat(20)).success).toBe(false);
    expect(refusal(RejectInput, { revision: 1, reason: 'too short' })).toEqual({
      code: 'VALIDATION_FAILED',
      status: 422,
      paths: [['reason']],
    });
    expect(refusal(RejectInput, { revision: 1 }).paths).toEqual([['reason']]);
  });

  it('query schemas reject unknown params', () => {
    for (const q of [{ sort: 'createdAt:asc' }, { page: '2' }, { offset: '25' }, { q: 'cab' }])
      expect([q, refusal(ClaimListQuery, q).code]).toEqual([q, 'VALIDATION_FAILED']);
    // a server-owned name is refused too (mapError's key rules are context-free: READ_ONLY_FIELD)
    expect(refusal(ClaimListQuery, { claimantId: LINE_ID })).toMatchObject({ status: 422 });
    // and bad values of known params
    for (const q of [
      { status: 'PAID' },
      { status: '' },
      { limit: '0' },
      { limit: '101' },
      { limit: '2.5' },
      { from: '2026-02-30' },
      { from: '2026-10-02', to: '2026-10-01' },
    ])
      expect([q, refusal(ClaimListQuery, q).code]).toEqual([q, 'VALIDATION_FAILED']);
    // positive control: what the list page actually sends
    expect(
      ClaimListQuery.parse({ status: 'DRAFT, SUBMITTED,DRAFT', from: '2026-09-01', limit: '10' }),
    ).toEqual({ status: ['DRAFT', 'SUBMITTED'], from: '2026-09-01', limit: 10 });
    expect(ClaimListQuery.parse({})).toEqual({
      status: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      limit: 25,
    });
  });
});
