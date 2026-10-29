// TC-U07 (§6-6): keyset cursors are opaque positions bound to the endpoint's sort and filters
// (C-09, 04 §8.2). Anything malformed or reused with other filters is 422 INVALID_CURSOR.
import { describe, expect, it } from 'vitest';
import { mapError } from '@/server/errors/map-error';
import { CursorError, decodeCursor, encodeCursor, type CursorFilters } from '@/shared/cursor';

const SORT = 'createdAt:desc';
const POS = { value: '2026-09-30T18:29:59.999Z', id: '0199c0de-0000-7000-8000-000000000001' };
const FILTERS: CursorFilters = {
  status: ['SUBMITTED', 'DRAFT'],
  from: '2026-09-01',
  to: undefined,
};

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const forged = (o: Record<string, unknown>) => {
  const real = JSON.parse(Buffer.from(encodeCursor(SORT, POS, FILTERS), 'base64url').toString());
  return b64url(JSON.stringify({ ...real, ...o }));
};

/** decodeCursor's refusal as the API reports it. */
function refusal(raw: string, filters: CursorFilters = FILTERS, sort = SORT) {
  try {
    decodeCursor(raw, sort, filters);
    return 'ACCEPTED';
  } catch (err) {
    expect(err).toBeInstanceOf(CursorError);
    const e = mapError(err);
    return `${e.status} ${e.code}`;
  }
}

describe('TC-U07 pagination', () => {
  it('cursor round-trips', () => {
    const raw = encodeCursor(SORT, POS, FILTERS);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    expect(decodeCursor(raw, SORT, FILTERS)).toEqual(POS);
    // the filter fingerprint is order-insensitive and ignores absent filters
    expect(
      decodeCursor(raw, SORT, { from: '2026-09-01', status: ['DRAFT', 'SUBMITTED', 'DRAFT'] }),
    ).toEqual(POS);
    // a millisecond instant survives a JS Date round trip exactly (timestamptz(3))
    expect(new Date(decodeCursor(raw, SORT, FILTERS).value!).toISOString()).toBe(POS.value);
    // a nullable sort column (finance list) round-trips its null
    const nullPos = { value: null, id: POS.id };
    expect(decodeCursor(encodeCursor(SORT, nullPos, {}), SORT, {})).toEqual(nullPos);
  });

  it('tampered cursor fails with INVALID_CURSOR', () => {
    const raw = encodeCursor(SORT, POS, FILTERS);
    const tampered = [
      raw.slice(0, -3), // truncated
      `${raw}!`, // not base64url
      `f${raw.slice(1)}`, // first byte is no longer '{'
      'e30', // {} : no fields
      b64url('not json'),
      b64url('[1,2,3]'),
      forged({ id: 'not-a-uuid' }),
      forged({ value: 'yesterday' }),
      forged({ value: 1_759_257_000_000 }),
      forged({ admin: true }), // strict: an extra field is not "ignored"
      forged({ sort: 'createdAt:asc' }), // a cursor from another endpoint's sort
      forged({ fh: '00000000' }),
      '',
    ];
    for (const t of tampered) expect([t, refusal(t)]).toEqual([t, '422 INVALID_CURSOR']);
    expect(refusal(raw, FILTERS, 'submittedAt:desc')).toBe('422 INVALID_CURSOR');
  });

  it('cursor issued for different filters fails with INVALID_CURSOR', () => {
    const raw = encodeCursor(SORT, POS, FILTERS);
    for (const other of [
      { ...FILTERS, status: ['DRAFT'] },
      { ...FILTERS, from: '2026-09-02' },
      { ...FILTERS, to: '2026-09-30' },
      { status: FILTERS.status },
      {},
    ])
      expect([other, refusal(raw, other)]).toEqual([other, '422 INVALID_CURSOR']);
    expect(refusal(raw)).toBe('ACCEPTED'); // positive control
  });
});
