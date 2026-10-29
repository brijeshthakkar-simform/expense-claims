import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { readSqlState } from '@/server/db/pg-error';
import { claimToCsvRows, csvPreamble, type ExportClaimRow } from '@/server/export/csv';

// 06 §6.6: a pull-based ReadableStream over keyset batches. No database access of its own (the
// caller injects fetchBatch), so a unit test can drive it with fakes. Memory is about one queued
// chunk plus one batch in flight, whatever the period length: pull() runs only when the consumer
// has drained the queue (high-water mark 1), so a slow client means fewer queries, not more memory.

/** The keyset position: the last emitted claim's (approved_at, id). */
export interface ExportCursor {
  approvedAt: Date;
  id: string;
}

/** Counted as the stream goes; logged on completion or failure. */
export interface ExportStreamStats {
  batches: number;
  claims: number;
  /** CSV records (line items), excluding the header row. */
  rows: number;
}

export interface ApprovedClaimsCsvStreamOptions {
  /** Claims per fetchBatch call; a batch shorter than this is the last one. */
  batchSize: number;
  log: Logger;
  /** One keyset batch of at most batchSize claims strictly after `after`, ordered (approvedAt, id). */
  fetchBatch: (after: ExportCursor | null) => Promise<ExportClaimRow[]>;
}

/**
 * BOM + header row up front, then one CSV chunk per batch. A batch shorter than `batchSize` closes
 * the stream (no extra empty query). Any error calls `controller.error()`, so the HTTP response is
 * aborted without its final chunk and the download fails visibly instead of looking complete
 * (06 §6.8); a client cancel stops further queries. Logs `export.completed` / `export.failed`.
 *
 * pull() and cancel() run in the async context the stream was created in (the request's), so their
 * log lines and queries keep the request's requestId/userId even though the consumer, not the
 * route handler, triggers them.
 */
export function approvedClaimsCsvStream(
  o: ApprovedClaimsCsvStreamOptions,
): ReadableStream<Uint8Array> {
  if (!Number.isInteger(o.batchSize) || o.batchSize < 1)
    throw new RangeError(`Bad batchSize: ${o.batchSize}`);
  const inRequestContext = AsyncLocalStorage.snapshot();
  const enc = new TextEncoder();
  const t0 = performance.now();
  const stats: ExportStreamStats = { batches: 0, claims: 0, rows: 0 };
  let after: ExportCursor | null = null;
  let cancelled = false;

  async function pullBatch(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      const claims = await o.fetchBatch(after);
      if (cancelled) return; // the consumer went away while the batch was in flight
      let chunk = '';
      for (const claim of claims) {
        chunk += claimToCsvRows(claim);
        stats.claims++;
        stats.rows += claim.snapshot.lines.length;
      }
      stats.batches++;
      if (chunk) c.enqueue(enc.encode(chunk));
      if (claims.length < o.batchSize) {
        c.close();
        o.log.info(
          {
            event: 'export.completed',
            ...stats,
            durationMs: Math.round(performance.now() - t0),
          },
          'export completed',
        );
        return;
      }
      const last = claims.at(-1)!;
      after = { approvedAt: last.approvedAt, id: last.id };
    } catch (err) {
      if (cancelled) return;
      o.log.error(
        { event: 'export.failed', reason: 'ERROR', sqlstate: readSqlState(err), err, ...stats },
        'export failed mid-stream',
      );
      c.error(err); // never a clean end: the response is aborted, the download fails
    }
  }

  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        c.enqueue(enc.encode(csvPreamble()));
      },
      pull: (c) => inRequestContext(pullBatch, c),
      cancel: () =>
        inRequestContext(() => {
          cancelled = true;
          o.log.warn(
            { event: 'export.failed', reason: 'CLIENT_CANCELLED', ...stats },
            'export cancelled by client',
          );
        }),
    },
    { highWaterMark: 1 }, // at most one chunk queued ahead of the client
  );
}
