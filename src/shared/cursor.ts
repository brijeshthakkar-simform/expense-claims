import { z } from 'zod';

// C-09 / 04 §8.2: an opaque keyset cursor = base64url(JSON { sort, value, id, fh }). `sort` is the
// endpoint's fixed sort, `value` the last row's sort value (ISO instant), `id` its UUID (the
// tiebreaker), `fh` a short hash of the normalised filters. Not signed, on purpose: a cursor is a
// position, not a permission, and tampering can only move the window inside the actor's WHERE.

/** A malformed cursor, or one issued for another sort or other filters → 422 INVALID_CURSOR. */
export class CursorError extends Error {
  override readonly name = 'CursorError';
  readonly code = 'INVALID_CURSOR' as const;
  constructor(reason: string) {
    super(`INVALID_CURSOR: ${reason}`);
  }
}

export interface CursorPosition {
  /** The last row's sort value as an ISO instant (null only for a nullable sort column). */
  value: string | null;
  id: string;
}

/** The filters a cursor is bound to (status, from, to, dateField; never limit). */
export type CursorFilters = Readonly<Record<string, string | readonly string[] | undefined>>;

const Payload = z.strictObject({
  sort: z.string(),
  value: z.iso.datetime().nullable(),
  id: z.uuid(),
  fh: z.string(),
});

/** FNV-1a 32-bit, hex. A fingerprint, not a MAC: it only detects filter changes. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Order-insensitive: keys sorted, list values sorted and de-duplicated, undefined dropped. */
export function filterHash(filters: CursorFilters): string {
  const normalised = Object.keys(filters)
    .sort()
    .flatMap((k) => {
      const v = filters[k];
      if (v === undefined) return [];
      return [[k, typeof v === 'string' ? v : [...new Set(v)].sort()]];
    });
  return fnv1a(JSON.stringify(normalised));
}

const toBase64Url = (text: string): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (raw: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new CursorError('not base64url');
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
};

export function encodeCursor(sort: string, pos: CursorPosition, filters: CursorFilters): string {
  return toBase64Url(
    JSON.stringify({ sort, value: pos.value, id: pos.id, fh: filterHash(filters) }),
  );
}

/** Throws CursorError unless `raw` is a well-formed cursor for this `sort` and these `filters`. */
export function decodeCursor(raw: string, sort: string, filters: CursorFilters): CursorPosition {
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(raw));
  } catch (e) {
    throw e instanceof CursorError ? e : new CursorError('malformed');
  }
  const p = Payload.safeParse(json);
  if (!p.success) throw new CursorError('malformed');
  if (p.data.sort !== sort) throw new CursorError('issued for a different sort');
  if (p.data.fh !== filterHash(filters)) throw new CursorError('issued for different filters');
  return { value: p.data.value, id: p.data.id };
}
