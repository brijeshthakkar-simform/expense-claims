// TC-I28 (§3.6-a/b, §6-6, RT-M5, RT-M6, RT-m2): GET /api/v1/finance/exports/approved-claims (06 §6,
// D-32, D-33). A claim is in the period when its FINAL approval instant falls in the IST days
// [from, to] and before asOf (the DB clock at request start); rows come from the approved
// submission's snapshot; the body is streamed in keyset batches of EXPORT_BATCH_SIZE (3 here, set
// in integration-setup.ts) and errors (never ends cleanly) on a mid-stream failure. Every case that
// reads a body runs the file-format checks (BOM, CRLF, 24 columns, ^\d+\.\d{2}$ money): readExport.
// Backdated approvals come from ownerDecideAt: only the owner may supply transition timestamps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as exportRoute from '@/app/api/v1/finance/exports/approved-claims/route';
import { readSqlState } from '@/server/db/pg-error';
import * as exportRepo from '@/server/repositories/export.repo';
import * as claimsService from '@/server/services/claims.service';
import * as exportService from '@/server/services/export.service';
import { formatBusinessIso, isExportPeriodOpen, todayInBusinessTz } from '@/shared/dates';
import type { ClaimDetail } from '@/shared/dto/claims';
import { asPersona, emailOf, type Persona } from '../../helpers/auth';
import {
  BOM_BYTES,
  checkExportFile,
  decodeKeepingBom,
  EXPECTED_COLUMNS,
  readExport,
  type CsvRecord,
  type ExportFile,
} from '../../helpers/csv';
import { appClient, appSql, ownerSql, rejects } from '../../helpers/db';
import {
  approveAs,
  ctx,
  lineInput,
  makeDraft,
  makeUser,
  ownerDecideAt,
  recallAs,
  rejectAs,
  submitAs,
  type LineSpec,
} from '../../helpers/factories';
import { callRoute, captureLogs, errorOf, type LogLine } from '../../helpers/http';
import { rawDecide } from '../../helpers/raw-submit';

const PATH = '/api/v1/finance/exports/approved-claims';
const SEP = { from: '2026-09-01', to: '2026-09-30' };
const OCT = { from: '2026-10-01', to: '2026-10-31' };
const HEADER_ONLY = `﻿${EXPECTED_COLUMNS.join(',')}\r\n`;

const exportAs = (
  as: Persona | null,
  query: Record<string, string>,
  headers?: Record<string, string>,
) => callRoute(exportRoute, 'GET', { path: PATH, query, ...(as && { as }), headers });

/** Farah's export of `query`: a 200 whose body passed the file-format checks. */
async function download(query: Record<string, string>): Promise<ExportFile & { res: Response }> {
  const res = await exportAs('farah', query);
  return { ...(await readExport(res)), res };
}
/** Claim numbers in file order (each once). */
const claimsIn = (f: ExportFile) => [...new Set(f.records.map((r) => r.claim_number))];
const lineIdsIn = (f: ExportFile) => f.records.map((r) => r.line_item_id);
const dataOf = (f: ExportFile) => f.text.slice(HEADER_ONLY.length); // the records, raw

async function chunksOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  return chunks;
}
const concat = (chunks: Uint8Array[]) => new Uint8Array(Buffer.concat(chunks));

/** The level-1 approver of a ≤ ₹10,000 claim (C-15). */
const L1: Partial<Record<Persona, Persona>> = { asha: 'ravi', arjun: 'neha' };

/** A ≤ ₹10,000 claim of `who`'s, submitted now and finally approved at `at` (owner SQL). */
async function approvedAt(
  at: string,
  o: { who?: Persona; lines?: LineSpec[]; title?: string } = {},
): Promise<ClaimDetail> {
  const who = o.who ?? 'asha';
  const lines = o.lines ?? [{ amountMinor: 500_000 }];
  const c = await submitAs(who, await makeDraft(who, { title: o.title, lines }));
  return ownerDecideAt(L1[who]!, c, 'APPROVED', at);
}

/** A fresh SUBMITTED claim of `who`'s, through the real services. */
const submitted = async (amountMinor = 500_000, who: Persona = 'asha') =>
  submitAs(who, await makeDraft(who, { lines: [{ amountMinor }] }));

const exportLines = (lines: LogLine[]) =>
  lines.filter((l) => typeof l.event === 'string' && l.event.startsWith('export.'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TC-I28 finance export', () => {
  it('includes only APPROVED claims approved within the period', async () => {
    // In September: a two-level ₹42,500.05 claim (two GL lines; Meera's final approval on 12 Sep)
    // and Arjun's ₹6,500 claim (Neha, 20 Sep)
    const big = await submitAs(
      'asha',
      await makeDraft('asha', {
        title: 'Client workshop, Pune',
        lines: [
          {
            amountMinor: 4_200_000,
            category: 'LODGING',
            expenseDate: '2026-09-08',
            description: 'Hotel, 2 nights',
            merchant: 'Taj Residency',
          },
          { amountMinor: 50_005, category: 'MEALS', expenseDate: '2026-09-09', description: 'Tea' },
        ],
      }),
    );
    await ownerDecideAt('ravi', big, 'APPROVED', '2026-09-05T06:00:00.000Z');
    const c1 = await ownerDecideAt('meera', big, 'APPROVED', '2026-09-12T06:00:00.000Z');
    const c2 = await approvedAt('2026-09-20T06:00:00.000Z', {
      who: 'arjun',
      lines: [{ amountMinor: 650_000 }],
    });
    // Not in September: approved in August or October, partly approved, rejected, submitted, draft
    const aug = await approvedAt('2026-08-20T06:00:00.000Z');
    const oct = await approvedAt('2026-10-03T06:00:00.000Z');
    const partial = await ownerDecideAt(
      'ravi',
      await submitted(2_500_000),
      'APPROVED',
      '2026-09-15T06:00:00.000Z',
    );
    await ownerDecideAt('ravi', await submitted(), 'REJECTED', '2026-09-16T06:00:00.000Z');
    await submitted();
    await makeDraft('asha', { lines: [{ amountMinor: 700 }] });

    const sep = await download(SEP);
    expect(claimsIn(sep)).toEqual([c1.claimNumber, c2.claimNumber]); // approved_at order
    expect(sep.records).toHaveLength(3); // one row per line item
    expect(claimsIn(sep)).not.toContain(partial.claimNumber);
    expect(sep.res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(sep.res.headers.get('content-disposition')).toBe(
      'attachment; filename="approved-claims_2026-09-01_2026-09-30.csv"',
    );
    expect(sep.res.headers.get('cache-control')).toBe('no-store');
    expect(sep.res.headers.get('x-request-id')).toBeTruthy();
    expect(sep.res.headers.get('x-export-period-open')).toBe('false');
    const asOf = sep.res.headers.get('x-export-as-of')!;
    expect(new Date(asOf).toISOString()).toBe(asOf);
    expect(Math.abs(Date.parse(asOf) - Date.now())).toBeLessThan(60_000);

    // The whole first record, from the contract (C-22) and the database
    const [asha] = await ownerSql<{ employee_code: string; dept: string; submitted_at: Date }>`
      SELECT u.employee_code, d.code AS dept, s.submitted_at
        FROM claims c
        JOIN users u ON u.id = c.claimant_id
        JOIN departments d ON d.id = u.department_id
        JOIN claim_submissions s ON s.id = c.current_submission_id
       WHERE c.id = ${c1.id}`;
    const shared = {
      claim_number: c1.claimNumber,
      claim_id: c1.id,
      revision: '1',
      employee_code: asha!.employee_code,
      employee_name: 'Asha Rao',
      employee_email: emailOf('asha'),
      department_code: asha!.dept,
      claim_title: 'Client workshop, Pune',
      submitted_at: formatBusinessIso(asha!.submitted_at),
      approved_at: '2026-09-12T11:30:00.000+05:30',
      posting_date: '2026-09-12',
      final_approver_email: emailOf('meera'), // the highest-level approver, not Ravi
      currency: 'INR',
      claim_total: '42500.05',
    };
    expect(sep.records.slice(0, 2)).toEqual([
      {
        ...shared,
        line_no: '1',
        line_item_id: c1.lineItems[0]!.id,
        expense_date: '2026-09-08',
        category_code: 'LODGING',
        category_name: 'Hotels & lodging',
        gl_code: '6110',
        description: 'Hotel, 2 nights',
        merchant: 'Taj Residency',
        amount: '42000.00',
        receipt_count: '0',
      },
      {
        ...shared,
        line_no: '2',
        line_item_id: c1.lineItems[1]!.id,
        expense_date: '2026-09-09',
        category_code: 'MEALS',
        category_name: 'Meals',
        gl_code: '6120',
        description: 'Tea',
        merchant: '',
        amount: '500.05',
        receipt_count: '0',
      },
    ] satisfies CsvRecord[]);
    expect(sep.records[2]).toMatchObject({
      claim_number: c2.claimNumber,
      employee_email: emailOf('arjun'),
      final_approver_email: emailOf('neha'),
      amount: '6500.00',
      claim_total: '6500.00',
      posting_date: '2026-09-20',
    });
    // The neighbours land in their own months
    expect(claimsIn(await download({ from: '2026-08-01', to: '2026-08-31' }))).toEqual([
      aug.claimNumber,
    ]);
    expect(claimsIn(await download(OCT))).toEqual([oct.claimNumber]);
  });

  it('partially approved, rejected, draft, recalled and resubmitted-in-flight claims never appear', async () => {
    const asha = await asPersona('asha');
    const approvedNow = await approveAs('ravi', await submitted(500_000));
    const partial = await approveAs('ravi', await submitted(2_500_000)); // [ravi ✓, meera]
    const rejected = await rejectAs('ravi', await submitted());
    const draft = await makeDraft('asha', { lines: [{ amountMinor: 800 }] });
    const recalled = await recallAs('asha', await submitted());
    const recalledAfterL1 = await recallAs(
      'asha',
      await approveAs('ravi', await submitted(2_500_000)),
    );
    // rejected, edited and resubmitted: in flight again (revision 2)
    const r = await rejectAs('ravi', await submitted(600_000));
    const edited = await claimsService.replaceClaim(ctx(asha), r.id, {
      title: r.title,
      lineItems: r.lineItems.map((l) => ({ ...lineInput(l), amountMinor: 650_000 })),
    });
    const inFlight = await submitAs('asha', edited);
    // rejected, resubmitted and then approved: appears once, with its final revision
    const r2 = await rejectAs('ravi', await submitted(700_000));
    const finallyApproved = await approveAs('ravi', await submitAs('asha', r2));
    expect([partial, inFlight].map((c) => c.status)).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(finallyApproved.currentRevision).toBe(2);

    const today = todayInBusinessTz();
    const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000);
    const wide = { from: yearAgo.toISOString().slice(0, 10), to: today }; // 366 days, the maximum
    for (const period of [{ from: today, to: today }, wide]) {
      const f = await download(period);
      expect(claimsIn(f)).toEqual([approvedNow.claimNumber, finallyApproved.claimNumber]);
      for (const c of [partial, rejected, draft, recalled, recalledAfterL1, inFlight])
        expect(claimsIn(f)).not.toContain(c.claimNumber);
      expect(f.records.map((x) => [x.claim_number, x.revision])).toEqual([
        [approvedNow.claimNumber, '1'],
        [finallyApproved.claimNumber, '2'],
      ]);
      expect(f.res.headers.get('x-export-period-open')).toBe('true'); // to = today
    }
    // The CHECK behind it: nothing but an APPROVED claim has an approved_at
    expect(
      await ownerSql`SELECT id FROM claims WHERE approved_at IS NOT NULL AND status <> 'APPROVED'`,
    ).toEqual([]);
  });

  it('IST boundaries: 2026-08-31T18:29:59.999Z excluded, 18:30:00.000Z included; 2026-09-30T18:29:59.999Z included, 18:30:00.000Z excluded', async () => {
    const instants = {
      augLast: '2026-08-31T18:29:59.999Z', // 31 Aug 23:59:59.999 IST
      sepFirst: '2026-08-31T18:30:00.000Z', // 1 Sep 00:00:00.000 IST
      sepLast: '2026-09-30T18:29:59.999Z', // 30 Sep 23:59:59.999 IST
      octFirst: '2026-09-30T18:30:00.000Z', // 1 Oct 00:00:00.000 IST
    };
    type Key = keyof typeof instants;
    const n = {} as Record<Key, string>;
    for (const [k, at] of Object.entries(instants) as [Key, string][])
      n[k] = (await approvedAt(at, { title: k })).claimNumber;

    const sep = await download(SEP);
    expect(claimsIn(sep)).toEqual([n.sepFirst, n.sepLast]);
    expect(sep.records.map((r) => [r.approved_at, r.posting_date])).toEqual([
      ['2026-09-01T00:00:00.000+05:30', '2026-09-01'],
      ['2026-09-30T23:59:59.999+05:30', '2026-09-30'],
    ]);
    const aug = await download({ from: '2026-08-01', to: '2026-08-31' });
    expect(claimsIn(aug)).toEqual([n.augLast]);
    expect(aug.records[0]!.posting_date).toBe('2026-08-31');
    const oct = await download(OCT);
    expect(claimsIn(oct)).toEqual([n.octFirst]);
    expect([oct.records[0]!.approved_at, oct.records[0]!.posting_date]).toEqual([
      '2026-10-01T00:00:00.000+05:30',
      '2026-10-01',
    ]);
    // Single days
    expect(claimsIn(await download({ from: '2026-09-01', to: '2026-09-01' }))).toEqual([
      n.sepFirst,
    ]);
    expect(claimsIn(await download({ from: '2026-09-30', to: '2026-09-30' }))).toEqual([n.sepLast]);
    expect(claimsIn(await download({ from: '2026-08-31', to: '2026-08-31' }))).toEqual([n.augLast]);
    expect(claimsIn(await download({ from: '2026-10-01', to: '2026-10-01' }))).toEqual([
      n.octFirst,
    ]);
  });

  it('Sep + Oct exports equal the Sep–Oct export with no duplicates', async () => {
    const ats = [
      '2026-08-31T18:30:00.000Z', // 1 Sep 00:00 IST
      '2026-09-15T06:30:00.000Z',
      '2026-09-15T06:30:00.000Z',
      '2026-09-15T06:30:00.000Z',
      '2026-09-30T18:29:59.999Z', // 30 Sep 23:59:59.999 IST
      '2026-09-30T18:30:00.000Z', // 1 Oct 00:00 IST
      '2026-09-30T18:30:00.000Z',
      '2026-10-05T06:30:00.000Z',
    ];
    for (const [i, at] of ats.entries())
      await approvedAt(at, {
        who: i % 3 === 2 ? 'arjun' : 'asha',
        lines: Array.from({ length: (i % 3) + 1 }, (_, j) => ({ amountMinor: 10_000 * (j + 1) })),
      });
    const total = await ownerSql<{ n: number }>`
      SELECT count(*)::int AS n FROM line_items li JOIN claims c ON c.id = li.claim_id
       WHERE c.status = 'APPROVED'`;

    const sep = await download(SEP);
    const oct = await download(OCT);
    const both = await download({ from: '2026-09-01', to: '2026-10-31' });
    expect(claimsIn(sep)).toHaveLength(5);
    expect(claimsIn(oct)).toHaveLength(3);
    // byte for byte: the two months' records, concatenated, are the two-month file's records
    expect(dataOf(sep) + dataOf(oct)).toBe(dataOf(both));
    expect([...sep.records, ...oct.records]).toEqual(both.records);
    const ids = lineIdsIn(both);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toHaveLength(total[0]!.n); // and nothing missing
    expect(lineIdsIn(sep).filter((id) => lineIdsIn(oct).includes(id))).toEqual([]);
  });

  it('keyset batches (batchSize=3) with tied approved_at emit every line exactly once', async () => {
    // 10 claims, 7 of them tied on approved_at, so batch boundaries fall inside the tie
    const tie = '2026-09-15T06:30:00.000Z';
    const ats = [
      '2026-09-02T06:30:00.000Z',
      ...Array<string>(7).fill(tie),
      '2026-09-20T06:30:00.000Z',
      '2026-09-29T06:30:00.000Z',
    ];
    for (const [i, at] of ats.entries())
      await approvedAt(at, {
        lines: Array.from({ length: (i % 3) + 1 }, (_, j) => ({ amountMinor: 1_000 + i * 10 + j })),
      });
    const expected = await ownerSql<{ claim_number: string; line_id: string }>`
      SELECT c.claim_number, li.id AS line_id
        FROM claims c JOIN line_items li ON li.claim_id = c.id
       WHERE c.status = 'APPROVED'
       ORDER BY c.approved_at, c.id, li.expense_date, li.id`;
    expect(expected).toHaveLength(19);

    // Through the route (EXPORT_BATCH_SIZE=3): the preamble, then one chunk per batch: 3+3+3+1
    const res = await exportAs('farah', SEP);
    expect(res.status).toBe(200);
    const chunks = await chunksOf(res.body!);
    expect(chunks).toHaveLength(5);
    expect(decodeKeepingBom(chunks[0]!)).toBe(HEADER_ONLY);
    expect(
      chunks.slice(1).map((c) => {
        const recs = checkExportFile(concat([chunks[0]!, c])).records;
        return new Set(recs.map((r) => r.claim_id)).size;
      }),
    ).toEqual([3, 3, 3, 1]);
    const file = checkExportFile(concat(chunks));
    expect(file.records.map((r) => [r.claim_number, r.line_item_id])).toEqual(
      expected.map((e) => [e.claim_number, e.line_id]),
    ); // every line exactly once, in (approved_at, id) order
    expect(new Set(lineIdsIn(file)).size).toBe(19);

    // The batch size changes the chunking, never the bytes
    const farah = await asPersona('farah');
    for (const [batchSize, chunkCount] of [
      [1, 11],
      [2, 6],
      [3, 5],
      [4, 4],
      [7, 3],
      [10, 2], // 10, then an empty batch that enqueues nothing
      [500, 2],
    ] as const) {
      const x = await exportService.openApprovedClaimsExport(ctx(farah), SEP, { batchSize });
      const c = await chunksOf(x.stream);
      expect([batchSize, c.length]).toEqual([batchSize, chunkCount]);
      expect([batchSize, decodeKeepingBom(concat(c))]).toEqual([batchSize, file.text]);
    }
  });

  it('a claim approved after asOf is excluded', async () => {
    const today = todayInBusinessTz();
    const month = { from: `${today.slice(0, 8)}01`, to: today };
    const before = [];
    for (let i = 0; i < 4; i++) before.push(await approveAs('ravi', await submitted()));
    const later = await submitted(); // approved through the service after the export starts
    const justBefore = await submitted(); // owner-approved at asOf − 1 ms
    const atAsOf = await submitted(); // owner-approved at exactly asOf

    const res = await exportAs('farah', month);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-period-open')).toBe('true');
    const asOf = new Date(res.headers.get('x-export-as-of')!);
    const reader = res.body!.getReader();
    const chunks = [(await reader.read()).value!]; // the preamble: the export is under way
    expect(decodeKeepingBom(chunks[0]!)).toBe(HEADER_ONLY);

    await approveAs('ravi', later); // approved_at = now() > asOf
    await ownerDecideAt('ravi', justBefore, 'APPROVED', new Date(asOf.getTime() - 1).toISOString());
    await ownerDecideAt('ravi', atAsOf, 'APPROVED', asOf.toISOString());
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);

    const file = checkExportFile(concat(chunks));
    // approved_at < asOf: the 4 earlier claims, and one committed in flight just below the cap
    expect(claimsIn(file)).toEqual([...before.map((c) => c.claimNumber), justBefore.claimNumber]);
    expect(claimsIn(file)).not.toContain(later.claimNumber);
    expect(claimsIn(file)).not.toContain(atAsOf.claimNumber);
    // A fresh export (a later asOf) has all of them
    const again = await download(month);
    expect([...claimsIn(again)].sort()).toEqual(
      [...before, later, justBefore, atAsOf].map((c) => c.claimNumber).sort(),
    );
  });

  it('rows come from the approved snapshot: renaming a category after approval does not change the CSV', async () => {
    const c = await approvedAt('2026-09-10T06:00:00.000Z', {
      lines: [
        { amountMinor: 120_000, category: 'MEALS', description: 'Team lunch' },
        { amountMinor: 80_000, category: 'LOCAL_TRANSPORT', description: 'Cab' },
      ],
    });
    const original = await download(SEP);
    expect(claimsIn(original)).toEqual([c.claimNumber]);
    expect(original.records.map((r) => [r.category_name, r.gl_code])).toEqual([
      ['Meals', '6120'],
      ['Local transport', '6103'],
    ]);

    const [meals] = await ownerSql<{ name: string; gl_code: string }>`
      SELECT name, gl_code FROM categories WHERE code = 'MEALS'`;
    const [asha] = await ownerSql<{ name: string }>`
      SELECT name FROM users WHERE email = ${emailOf('asha')}`;
    try {
      // Reference data and the claimant's details change after approval
      await ownerSql`UPDATE categories SET name = 'Food & beverages', gl_code = '6999'
                      WHERE code = 'MEALS'`;
      await ownerSql`UPDATE users SET name = 'Asha Rao-Iyer' WHERE email = ${emailOf('asha')}`;
      const after = await download(SEP);
      expect(after.bytes).toEqual(original.bytes); // byte for byte
      expect(after.records[0]).toMatchObject({
        category_name: 'Meals',
        gl_code: '6120',
        employee_name: 'Asha Rao',
      });
      // ...while the live detail shows the new names
      const live = await claimsService.getClaim(ctx(await asPersona('farah')), c.id);
      expect(live.lineItems.map((l) => l.category.name)).toContain('Food & beverages');
    } finally {
      await ownerSql`UPDATE categories SET name = ${meals!.name}, gl_code = ${meals!.gl_code}
                      WHERE code = 'MEALS'`;
      await ownerSql`UPDATE users SET name = ${asha!.name} WHERE email = ${emailOf('asha')}`;
    }
  });

  it('formula payloads in description, merchant, names and category are escaped', async () => {
    const hyperlink = '=HYPERLINK("http://evil.example","Click")';
    const tmp = await makeUser({ manager: 'ravi' });
    await ownerSql`UPDATE users SET name = ${hyperlink} WHERE id = ${tmp.id}`;
    const claimant = await asPersona({ email: tmp.email });
    const [meals] = await ownerSql<{
      name: string;
    }>`SELECT name FROM categories WHERE code = 'MEALS'`;
    let c: ClaimDetail;
    try {
      await ownerSql`UPDATE categories SET name = '@SUM(1+1)' WHERE code = 'MEALS'`;
      const draft = await makeDraft(claimant, {
        title: '+cmd|"/c calc"!A1',
        lines: [
          { amountMinor: 50_000, category: 'MEALS', description: '-2+3 cab', merchant: '=1+1' },
          {
            amountMinor: 20_000,
            category: 'MISC',
            description: '@SUM(A1:A9)',
            merchant: '+91 98450',
          },
          { amountMinor: 10_000, category: 'MISC', description: 'Plain text', merchant: 'Safe Co' },
        ],
      });
      c = await approveAs('ravi', await submitAs(claimant, draft), {
        at: '2026-09-10T06:00:00.000Z',
      });
    } finally {
      await ownerSql`UPDATE categories SET name = ${meals!.name} WHERE code = 'MEALS'`;
    }

    const f = await download(SEP);
    expect(claimsIn(f)).toEqual([c.claimNumber]);
    // Guard first, then RFC 4180 quoting
    expect(f.text).toContain(`"'=HYPERLINK(""http://evil.example"",""Click"")"`);
    const byDescription = Object.fromEntries(f.records.map((r) => [r.description, r]));
    expect(byDescription["'-2+3 cab"]).toMatchObject({
      employee_name: `'${hyperlink}`,
      claim_title: `'+cmd|"/c calc"!A1`,
      category_name: "'@SUM(1+1)", // the snapshot kept the payload
      merchant: "'=1+1",
    });
    expect(byDescription["'@SUM(A1:A9)"]).toMatchObject({ merchant: "'+91 98450" });
    expect(byDescription['Plain text']).toMatchObject({
      merchant: 'Safe Co',
      category_name: 'Miscellaneous',
    });
    // No cell in the whole file starts with a formula trigger, even after leading whitespace...
    const trigger = /^(\s*[=+\-@]|[\t\r])/;
    const cells = f.records.flatMap((r) => EXPECTED_COLUMNS.map((col) => [col, r[col]] as const));
    expect(cells.filter(([, v]) => trigger.test(v))).toEqual([]);
    // ...and every escaped cell starts with ' followed by the payload: 5 + 4 + 2 cells
    const escaped = cells.filter(([, v]) => v.startsWith("'"));
    expect(escaped.map(([col]) => col).sort()).toEqual(
      [
        ...['employee_name', 'claim_title', 'category_name', 'description', 'merchant'],
        ...['employee_name', 'claim_title', 'description', 'merchant'],
        ...['employee_name', 'claim_title'],
      ].sort(),
    );
    for (const [, v] of escaped) expect(v.slice(1)).toMatch(trigger);
  });

  it('an empty period returns a header-only CSV', async () => {
    await approvedAt('2026-09-10T06:00:00.000Z'); // something exists, just not in January
    for (const [period, open] of [
      [{ from: '2026-01-01', to: '2026-01-31' }, 'false'],
      [{ from: '2030-01-01', to: '2030-01-31' }, 'true'], // the future: empty and still open
    ] as const) {
      const f = await download(period);
      expect(f.records).toEqual([]);
      expect(f.text).toBe(HEADER_ONLY);
      expect([...f.bytes.subarray(0, 3)]).toEqual([...BOM_BYTES]);
      expect(f.res.headers.get('content-disposition')).toBe(
        `attachment; filename="approved-claims_${period.from}_${period.to}.csv"`,
      );
      expect(f.res.headers.get('x-export-period-open')).toBe(open);
    }
  });

  it('status=APPROVED is accepted and returns the same CSV as omitting status', async () => {
    await approvedAt('2026-09-03T06:00:00.000Z', {
      lines: [{ amountMinor: 1_000 }, { amountMinor: 2_050, merchant: 'Cafe, "Corner"' }],
    });
    await approvedAt('2026-09-15T06:00:00.000Z', { who: 'arjun' });
    await approvedAt('2026-09-29T06:00:00.000Z', {
      lines: [{ amountMinor: 99_999 }, { amountMinor: 1 }],
    });
    const plain = await download(SEP);
    const filtered = await download({ ...SEP, status: 'APPROVED' });
    expect(plain.records).toHaveLength(5);
    expect(filtered.bytes).toEqual(plain.bytes); // byte for byte (a closed period)
    for (const h of ['content-type', 'content-disposition', 'x-export-period-open'])
      expect(filtered.res.headers.get(h)).toBe(plain.res.headers.get(h));
  });

  it('status=REJECTED returns 422 EXPORT_STATUS_NOT_ALLOWED', async () => {
    await approvedAt('2026-09-10T06:00:00.000Z');
    await ownerDecideAt('ravi', await submitted(), 'REJECTED', '2026-09-11T06:00:00.000Z');
    for (const status of ['REJECTED', 'SUBMITTED', 'DRAFT', 'approved', 'APPROVED,REJECTED', '']) {
      const res = await exportAs('farah', { ...SEP, status });
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(res.headers.get('content-disposition')).toBeNull();
      const body = await errorOf(res);
      expect([status, res.status, body.error.code]).toEqual([
        status,
        422,
        'EXPORT_STATUS_NOT_ALLOWED',
      ]);
    }
  });

  it('a range over 366 days returns 422 EXPORT_RANGE_TOO_LARGE', async () => {
    await approvedAt('2026-09-10T06:00:00.000Z');
    const ok = [
      { from: '2025-09-30', to: '2026-09-30' }, // 366 days inclusive
      { from: '2028-01-01', to: '2028-12-31' }, // a leap year: 366 days
      { from: '2026-09-30', to: '2026-09-30' }, // one day
    ];
    for (const period of ok) {
      const f = await download(period);
      expect(f.records.length).toBe(period.from === '2025-09-30' ? 1 : 0);
    }
    const tooLong = [
      { from: '2025-09-29', to: '2026-09-30' }, // 367 days
      { from: '2027-12-31', to: '2028-12-31' }, // 367 days across a leap year
      { from: '2020-01-01', to: '2026-09-30' },
    ];
    for (const period of tooLong) {
      const res = await exportAs('farah', period);
      expect([period, res.status, (await errorOf(res)).error.code]).toEqual([
        period,
        422,
        'EXPORT_RANGE_TOO_LARGE',
      ]);
    }
    // Other bad periods are plain validation failures
    const invalid: Record<string, string>[] = [
      { from: '2026-09-30', to: '2026-09-01' }, // from > to
      { from: '2026-09-01' },
      { to: '2026-09-30' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '01/09/2026', to: '2026-09-30' },
      { ...SEP, format: 'xlsx' }, // unknown param
    ];
    for (const query of invalid) {
      const res = await exportAs('farah', query);
      expect([query, res.status, (await errorOf(res)).error.code]).toEqual([
        query,
        422,
        'VALIDATION_FAILED',
      ]);
    }
  });

  it('a non-finance user gets 403 FORBIDDEN and no auth gets 401', async () => {
    await approvedAt('2026-09-10T06:00:00.000Z');
    const logs = captureLogs();
    try {
      for (const who of ['asha', 'ravi', 'meera', 'deepa', 'admin'] as const) {
        const res = await exportAs(who, SEP);
        expect(res.headers.get('content-disposition')).toBeNull();
        expect([who, res.status, (await errorOf(res)).error.code]).toEqual([who, 403, 'FORBIDDEN']);
      }
      const anon = await exportAs(null, SEP);
      expect([anon.status, (await errorOf(anon)).error.code]).toEqual([401, 'UNAUTHENTICATED']);
      const garbage = await exportAs(null, SEP, { cookie: 'ec_session=not-a-token' });
      expect([garbage.status, (await errorOf(garbage)).error.code]).toEqual([
        401,
        'UNAUTHENTICATED',
      ]);
    } finally {
      logs.stop();
    }
    expect(exportLines(logs.lines)).toEqual([]); // refused before the service ran
    expect((await download(SEP)).records).toHaveLength(1); // the positive control
  });

  it('an injected DB error mid-stream errors the stream (no clean end)', async () => {
    for (let i = 0; i < 7; i++) await approvedAt(`2026-09-1${i}T06:00:00.000Z`); // batches 3+3+1
    const logs = captureLogs();
    let mid: Response | undefined;
    let early: Response | undefined;
    const received: Uint8Array[] = [];
    let failure: unknown = null;
    let earlyFailure: unknown = null;
    try {
      // (a) The owner revokes SELECT on claim_submissions after the first batch has been read
      mid = await exportAs('farah', SEP);
      expect(mid.status).toBe(200); // the headers are already out
      const reader = mid.body!.getReader();
      received.push((await reader.read()).value!, (await reader.read()).value!); // preamble + batch 1
      await ownerSql`REVOKE SELECT ON claim_submissions FROM expense_app`;
      try {
        for (let r = await reader.read(); !r.done; r = await reader.read()) received.push(r.value);
      } catch (err) {
        failure = err;
      }
      // (b) The same failure on the first batch: res.text() rejects instead of resolving
      early = await exportAs('farah', SEP);
      expect(early.status).toBe(200);
      earlyFailure = await early.text().then(
        () => null,
        (err: unknown) => err,
      );
    } finally {
      await ownerSql`GRANT SELECT ON claim_submissions TO expense_app`;
      logs.stop();
    }
    expect(failure, 'the stream ended cleanly after a DB error').not.toBeNull();
    expect(readSqlState(failure)).toBe('42501'); // insufficient_privilege
    expect(earlyFailure, 'res.text() resolved after a DB error').not.toBeNull();
    expect(readSqlState(earlyFailure)).toBe('42501');
    // What arrived is a valid prefix: the preamble and whole batches, never all 7 claims
    const partial = checkExportFile(concat(received));
    expect(claimsIn(partial).length).toBeGreaterThanOrEqual(3);
    expect(claimsIn(partial).length).toBeLessThan(7);

    // Logged: started then failed (error, with the SQLSTATE), never completed
    const lines = exportLines(logs.lines);
    for (const res of [mid!, early!]) {
      const mine = lines.filter((l) => l.requestId === res.headers.get('x-request-id'));
      expect(mine.map((l) => [l.event, l.level])).toEqual([
        ['export.started', 'info'],
        ['export.failed', 'error'],
      ]);
      expect(mine[1]).toMatchObject({ reason: 'ERROR', sqlstate: '42501' });
    }
    // With the privilege back, the same export completes
    expect(claimsIn(await download(SEP))).toHaveLength(7);
  });

  it('backdating approved_at as expense_app raises UC010', async () => {
    const backdate = '2026-09-15T06:00:00.000Z';
    const inFlight = await submitted();
    const rejected = await rejectAs('ravi', await submitted());
    // approved_at is stamped by the database at the →APPROVED transition and never written after
    for (const c of [inFlight, rejected])
      await rejects(
        'UC010',
        () => appSql`UPDATE claims SET approved_at = ${backdate}::timestamptz WHERE id = ${c.id}`,
      );
    // An APPROVED claim is terminal: moving its approved_at is refused before anything else
    const approved = await approveAs('ravi', await submitted());
    await rejects(
      'UC001',
      () =>
        appSql`UPDATE claims SET approved_at = ${backdate}::timestamptz WHERE id = ${approved.id}`,
    );
    // A final approval written raw by expense_app with a September approved_at is stamped now()
    const ravi = await asPersona('ravi');
    await rawDecide(await appClient(), inFlight.id, {
      approverId: ravi.id,
      outcome: 'APPROVED',
      at: backdate,
    });
    const [row] = await ownerSql<{ approved_at: Date }>`
      SELECT approved_at FROM claims WHERE id = ${inFlight.id}`;
    expect(Math.abs(row!.approved_at.getTime() - Date.now())).toBeLessThan(60_000);
    // ...so it can't land in a closed month
    expect(claimsIn(await download(SEP))).toEqual([]);
    const today = todayInBusinessTz();
    expect(claimsIn(await download({ from: today, to: today }))).toEqual([
      approved.claimNumber,
      inFlight.claimNumber,
    ]);
  });

  it('X-Export-Period-Open is true until 2 minutes after the period ends', async () => {
    // September ends at 2026-09-30T18:30:00.000Z (1 Oct 00:00 IST); the window closes 2 min later
    const open = (at: string) => isExportPeriodOpen('2026-09-30', new Date(at));
    expect(open('2026-09-15T00:00:00.000Z')).toBe(true);
    expect(open('2026-09-30T18:29:59.999Z')).toBe(true);
    expect(open('2026-09-30T18:30:00.000Z')).toBe(true);
    expect(open('2026-09-30T18:31:59.999Z')).toBe(true);
    expect(open('2026-09-30T18:32:00.000Z')).toBe(false);
    expect(open('2026-10-15T00:00:00.000Z')).toBe(false);

    // Through the route, with the DB clock pinned at both sides of the window's end
    const c = await approvedAt('2026-09-30T18:29:59.999Z'); // the last instant of September
    const asOfNow = vi.spyOn(exportRepo, 'asOfNow');
    for (const [asOf, expected] of [
      ['2026-09-30T18:31:59.999Z', 'true'],
      ['2026-09-30T18:32:00.000Z', 'false'],
    ] as const) {
      asOfNow.mockResolvedValueOnce(new Date(asOf));
      const f = await download(SEP);
      expect([asOf, f.res.headers.get('x-export-period-open')]).toEqual([asOf, expected]);
      expect(f.res.headers.get('x-export-as-of')).toBe(asOf);
      expect(claimsIn(f)).toEqual([c.claimNumber]);
    }
    expect(asOfNow).toHaveBeenCalledTimes(2);
    asOfNow.mockRestore();

    // The real clock: a period ending today is open; September (long closed) is not
    const dbNow = async () => (await ownerSql<{ t: Date }>`SELECT clock_timestamp() AS t`)[0]!.t;
    const before = await dbNow();
    const today = todayInBusinessTz();
    const current = await download({ from: today, to: today });
    expect(current.res.headers.get('x-export-period-open')).toBe('true');
    const closed = await download(SEP);
    expect(closed.res.headers.get('x-export-period-open')).toBe('false');
    const after = await dbNow();
    for (const f of [current, closed]) {
      const asOf = Date.parse(f.res.headers.get('x-export-as-of')!);
      expect(asOf).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(asOf).toBeLessThanOrEqual(after.getTime());
    }
  });
});
