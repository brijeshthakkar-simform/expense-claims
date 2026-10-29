import 'server-only';

// C-08 success envelopes. defineRoute adds x-request-id and Cache-Control: no-store to all of them.

/** 200 `{ data }`. */
export const ok = <T>(data: T, init?: ResponseInit): Response =>
  Response.json({ data }, { status: 200, ...init });

/** 201 `{ data }`. */
export const created = <T>(data: T, init?: ResponseInit): Response =>
  Response.json({ data }, { ...init, status: 201 });

/** 204, no body (logout, deletes). */
export const noContent = (init?: ResponseInit): Response =>
  new Response(null, { ...init, status: 204 });

/**
 * `Content-Disposition: attachment` with an ASCII-safe `filename` and the exact name as RFC 5987
 * `filename*`, so no file name can inject a header or a parameter (06 §5.4 "File name").
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, '_').trim() || 'download';
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 200 streamed file download (receipt content, C-08): the STORED content type, `attachment` and
 * `nosniff`, so a PDF or image is never rendered inline from our origin, and `no-store`.
 */
export const fileAttachment = (f: {
  body: ReadableStream<Uint8Array>;
  sizeBytes: number;
  fileName: string;
  contentType: string;
}): Response =>
  new Response(f.body, {
    status: 200,
    headers: {
      'content-type': f.contentType,
      'content-length': String(f.sizeBytes),
      'content-disposition': attachmentDisposition(f.fileName),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });

/**
 * 200 streamed CSV download (the finance export, C-08): `text/csv; charset=utf-8`, `attachment`
 * with the server-built file name (only digits, letters, `-`, `_` and `.`, so it needs no
 * escaping), `no-store`, plus any extra headers (X-Export-As-Of, X-Export-Period-Open). No
 * Content-Length: the body is produced batch by batch, so it is sent chunked.
 */
export function csvDownload(f: {
  body: ReadableStream<Uint8Array>;
  fileName: string;
  headers?: Record<string, string>;
}): Response {
  if (!/^[\w.-]+$/.test(f.fileName)) throw new RangeError(`Unsafe CSV file name: ${f.fileName}`);
  return new Response(f.body, {
    status: 200,
    headers: {
      ...f.headers,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${f.fileName}"`,
      'cache-control': 'no-store',
    },
  });
}

/** 200 `{ data: T[], page: { nextCursor, limit } }`: the C-08 list envelope. */
export const okPage = <T>(
  p: { items: readonly T[]; nextCursor: string | null; limit: number },
  init?: ResponseInit,
): Response =>
  Response.json(
    { data: p.items, page: { nextCursor: p.nextCursor, limit: p.limit } },
    { status: 200, ...init },
  );
