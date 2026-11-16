import 'server-only';
import { AppError } from '@/server/errors/app-error';
import type { ApiIssue } from '@/shared/errors';
import { RECEIPT_MAX_BYTES } from '@/shared/policy';

// 06 §5.4 "Size" and "Shape": the receipt upload is the one multipart route. defineRoute has
// already required multipart/form-data (415); this reads the body without ever buffering more
// than the cap, whatever Content-Length says (or doesn't).

/** The file (default 10 MiB, see policy.ts) plus room for the framing (D-30: 64 KiB). */
export const RECEIPT_REQUEST_MAX_BYTES = RECEIPT_MAX_BYTES + 64 * 1024;

const shapeError = (message: string, cause?: unknown) =>
  new AppError(
    'VALIDATION_FAILED',
    undefined,
    { issues: [{ path: ['file'], message, code: 'custom' }] satisfies ApiIssue[] },
    cause === undefined ? undefined : { cause },
  );

/**
 * The single `file` part of a receipt upload. 413 PAYLOAD_TOO_LARGE when Content-Length exceeds
 * the cap (checked before reading) or the streamed body does (a missing or lying Content-Length
 * can't make us buffer more); 422 VALIDATION_FAILED unless the body is well-formed multipart with
 * exactly one part, a file named `file`.
 */
export async function readReceiptFile(req: Request): Promise<File> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (declared > RECEIPT_REQUEST_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
  if (!req.body) throw shapeError('Attach one file in the field "file".');

  let seen = 0;
  let exceeded = false;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > RECEIPT_REQUEST_MAX_BYTES) {
        exceeded = true;
        controller.error(new AppError('PAYLOAD_TOO_LARGE')); // also cancels the request body
        return;
      }
      controller.enqueue(chunk);
    },
  });

  let form: FormData;
  try {
    form = await new Response(req.body.pipeThrough(limit), {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData();
  } catch (err) {
    if (exceeded) throw new AppError('PAYLOAD_TOO_LARGE');
    throw shapeError('The upload is not valid multipart/form-data.', err);
  }

  const parts = [...form.keys()];
  const file = form.get('file');
  if (parts.length !== 1 || !(file instanceof File))
    throw shapeError('Attach exactly one file in the field "file".');
  return file;
}
