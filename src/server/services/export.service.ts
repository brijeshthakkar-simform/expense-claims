import 'server-only';
import { requireRole } from '@/server/auth/actor';
import { env } from '@/server/env';
import { approvedClaimsCsvStream } from '@/server/export/export-stream';
import { loggerFor } from '@/server/logging/logger';
import * as exportRepo from '@/server/repositories/export.repo';
import type { ServiceCtx } from '@/server/services/context';
import { businessDayRangeToUtc, isExportPeriodOpen } from '@/shared/dates';
import { exportFileName } from '@/shared/dto/finance';
import { ExportQuery } from '@/shared/schemas/queries';

// The approved-claims export (§3.6, D-32, D-33, 06 §6). FINANCE only, checked twice: by the route's
// role gate before any query, and by requireRole as the first line of every function here (D-04,
// TC-U09). The period is the FINAL APPROVAL instant: approved_at ∈ [from 00:00 IST, (to + 1)
// 00:00 IST) and approved_at < asOf.

export interface ExportOptions {
  /** Claims per keyset batch. Tests only (e.g. 3, to cross batch boundaries); default env. */
  batchSize?: number;
}

export interface ApprovedClaimsExport {
  /** BOM + header, then one chunk per batch; errors (never ends cleanly) on a mid-stream failure. */
  stream: ReadableStream<Uint8Array>;
  /** The DB clock at request start: approvals at or after it are not in the file. */
  asOf: Date;
  /** True until 2 minutes after the period ends (the settle window): export again after close. */
  periodOpen: boolean;
  /** `approved-claims_<from>_<to>.csv` */
  fileName: string;
}

/**
 * Validates the period, reads `asOf` (the only query before the 200: a DB failure here is a JSON
 * 503), logs `export.started` and returns the lazy CSV stream. Nothing else is read until the
 * consumer pulls; each pull is one keyset batch (06 §6.6).
 */
export async function openApprovedClaimsExport(
  ctx: ServiceCtx,
  input: ExportQuery,
  opts: ExportOptions = {},
): Promise<ApprovedClaimsExport> {
  requireRole(ctx.actor, 'FINANCE'); // self-guard (D-04, RT-M11), before any query
  const q = ExportQuery.parse(input); // callers other than the route get the same 422s
  const { gte, lt } = businessDayRangeToUtc(q.from, q.to) as { gte: Date; lt: Date };
  const asOf = await exportRepo.asOfNow();
  const periodOpen = isExportPeriodOpen(q.to, asOf);
  const log = loggerFor({ requestId: ctx.requestId, userId: ctx.actor.id });
  log.info(
    { event: 'export.started', from: q.from, to: q.to, asOf: asOf.toISOString(), periodOpen },
    'export started',
  );
  const batchSize = opts.batchSize ?? env().EXPORT_BATCH_SIZE;
  const { actor } = ctx;
  const stream = approvedClaimsCsvStream({
    batchSize,
    log,
    fetchBatch: (after) =>
      exportRepo.approvedClaimsBatch(actor, { gte, lt, asOf, after, limit: batchSize }),
  });
  return { stream, asOf, periodOpen, fileName: exportFileName(q) };
}
