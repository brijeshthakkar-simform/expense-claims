// TC-I08 (03 §16.2–16.5, proof J10): the hand-written SQL that Prisma doesn't model is present
// exactly as verified. Catches anyone "cleaning up" a migration. P0 objects plus the P3 workflow
// migration's; the P6 receipts migration extends both lists.
import { describe, expect, it } from 'vitest';
import { ownerSql } from '../../helpers/db';

const EXPECTED_FUNCTIONS = [
  'approval_steps_guard', // P3
  'assert_claim_editable', // v2 in P3 (the snapshot freeze)
  'assert_claim_total_consistent',
  'assert_transition_audited', // P3
  'claim_submissions_verify', // P3
  'claims_guard', // v2 in P3 (the full transition whitelist)
  'forbid_mutation', // P3
  'line_items_before_write',
  'line_items_recompute_claim_totals',
  'next_claim_number',
  'receipts_before_write', // P6
];

// claims_guard is the ONLY BEFORE trigger on claims (RT-B1(e)).
const EXPECTED_TRIGGERS: Record<string, string[]> = {
  claims: ['claims_10_guard', 'claims_90_total_consistent', 'claims_95_transition_audited'],
  line_items: [
    'line_items_10_before_write',
    'line_items_20_recompute_after_delete',
    'line_items_20_recompute_after_insert',
    'line_items_20_recompute_after_update',
    'line_items_90_total_consistent',
  ],
  // P3 (workflow)
  approval_steps: ['approval_steps_10_guard', 'approval_steps_95_transition_audited'],
  claim_events: ['claim_events_00_guard'],
  claim_submissions: ['claim_submissions_00_append_only', 'claim_submissions_10_verify'],
  // P6 (receipts)
  receipts: ['receipts_10_before_write'],
};

describe('TC-I08 schema objects', () => {
  it('every plpgsql function pins search_path = pg_catalog, public, pg_temp', async () => {
    // Every function in public, not only PL/pgSQL: next_claim_number() is SQL and pins it too.
    const functions = await ownerSql<{ proname: string; config: string[] | null }>`
      SELECT p.proname, p.proconfig::text[] AS config FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace ORDER BY p.proname`;

    expect(functions.map((f) => f.proname)).toEqual(EXPECTED_FUNCTIONS);
    for (const f of functions)
      expect(
        f.config ?? [],
        `${f.proname} pins search_path (temp-table shadowing, RT-M10)`,
      ).toContain('search_path=pg_catalog, public, pg_temp');
  });

  it('each table has exactly the expected triggers, all enabled', async () => {
    const triggers = await ownerSql<{ relname: string; tgname: string; tgenabled: string }>`
      SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
       ORDER BY c.relname, t.tgname`;

    const byTable: Record<string, string[]> = {};
    for (const t of triggers) (byTable[t.relname] ??= []).push(t.tgname);
    expect(byTable).toEqual(EXPECTED_TRIGGERS);
    expect(
      triggers.filter((t) => t.tgenabled !== 'O').map((t) => `${t.relname}.${t.tgname}`),
      'disabled or replica-only triggers',
    ).toEqual([]);
  });
});
