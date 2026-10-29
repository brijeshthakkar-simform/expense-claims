import 'server-only';
import { getDb } from '@/server/db/client';

export interface TotalDriftRow {
  claimId: string;
  totalMinor: number;
  /** text: a bigint SUM can exceed a JS safe integer only if something is badly wrong. */
  lineSum: string;
}

/**
 * The auditor view (03 §4.2 layer 6): claims whose stored total differs from the sum of their
 * lines. It must always be empty. `security_invoker`, so it reads with the caller's grants.
 */
export function readTotalDrift(): Promise<TotalDriftRow[]> {
  return getDb().$queryRaw<TotalDriftRow[]>`
    SELECT claim_id AS "claimId", total_minor AS "totalMinor", line_sum::text AS "lineSum"
      FROM public.v_claim_total_drift
     ORDER BY claim_id`;
}
