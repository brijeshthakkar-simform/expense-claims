import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import type { z } from 'zod';

/**
 * List filters live in the URL (05 §10.1, F7): shareable, survive a refresh, deep-linkable. The URL
 * params ARE the API params (minus `cursor`/`limit`), and they are parsed with the API's own strict
 * query schema, so the UI never sends a param the API would answer with 422.
 */

/** Search params as they travel: lists are comma-joined (`status=APPROVED,REJECTED`). */
export type UrlParams = Readonly<Record<string, string>>;

/** A filter change: `undefined`, `''` or `[]` removes the param. */
export type UrlPatch = Readonly<Record<string, string | readonly string[] | undefined>>;

export type UrlSetResult = { ok: true } | { ok: false; error: z.ZodError };

export interface UrlQuery<T> {
  /** The schema's output: what the server will see, defaults filled in. */
  value: T;
  /** The valid filter params exactly as written in the URL: sent to the API, used in cache keys. */
  params: UrlParams;
  /**
   * Validates the patched params with the shared schema first; on success replaces the URL (no new
   * history entry, no scroll jump). A refused patch (e.g. `from` after `to`) leaves the URL alone.
   */
  set: (patch: UrlPatch) => UrlSetResult;
}

/** Pagination never lives in the URL: "Load more" is in-memory state of the list. */
const PAGINATION_KEYS = new Set(['cursor', 'limit']);

const patchValue = (v: string | readonly string[] | undefined): string =>
  v === undefined ? '' : typeof v === 'string' ? v : v.join(',');

/** `{ status: ['A', 'B'], from: '2026-10-01', cursor: undefined }` → `status=A%2CB&from=2026-10-01` */
export function toSearch(
  params: Readonly<Record<string, string | number | readonly string[] | null | undefined>>,
): string {
  const sp = new URLSearchParams();
  for (const [key, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v.join(',');
    if (s !== '') sp.set(key, s);
  }
  return sp.toString();
}

/**
 * `[value, params, set]` for a list page, from the current URL. A URL the schema refuses (garbage
 * param, impossible date, `from > to`) falls back to the schema's defaults, and the next `set`
 * starts from those defaults, dropping the garbage.
 *
 * Callers sit inside `<Suspense>` (useSearchParams), so `next build` can prerender the shell.
 */
export function useUrlQuery<S extends z.ZodType>(schema: S): UrlQuery<z.output<S>> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = searchParams.toString();

  return useMemo(() => {
    const raw: Record<string, string> = {};
    for (const [key, v] of new URLSearchParams(search)) {
      if (!PAGINATION_KEYS.has(key)) raw[key] = v;
    }
    const parsed = schema.safeParse(raw);
    const params: UrlParams = parsed.success ? raw : {};
    const value: z.output<S> = parsed.success ? parsed.data : schema.parse({});

    const set = (patch: UrlPatch): UrlSetResult => {
      const merged = new Map(Object.entries(params));
      for (const [key, v] of Object.entries(patch)) merged.set(key, patchValue(v));
      const next: Record<string, string> = {};
      for (const [key, v] of merged) {
        if (v !== '' && !PAGINATION_KEYS.has(key)) next[key] = v;
      }
      const check = schema.safeParse(next);
      if (!check.success) return { ok: false, error: check.error };
      // Commas are legal in a query string; keep `status=APPROVED,REJECTED` readable.
      const qs = new URLSearchParams(next).toString().replaceAll('%2C', ',');
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      return { ok: true };
    };

    return { value, params, set };
  }, [schema, search, router, pathname]);
}
