// TC-U06 (§3.6-a, RT-m2): the bookkeeping CSV (06 §6.4–6.5, C-22). RFC 4180 quoting with CRLF, the
// OWASP formula guard on every text column we did not generate, generated columns written raw, and
// a UTF-8 BOM first. Expected values are written out from the contract; the RFC 4180 reader in
// tests/helpers/csv.ts is independent of src/server/export.
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  CSV_COLUMNS,
  claimToCsvRows,
  csvField,
  csvLine,
  csvPreamble,
  csvText,
  type ExportClaimRow,
} from '@/server/export/csv';
import { approvedClaimsCsvStream, type ExportCursor } from '@/server/export/export-stream';
import type { SnapshotLineV1, SnapshotV1 } from '@/shared/dto/snapshot';
import {
  BOM_BYTES,
  checkExportFile,
  DECIMAL,
  decodeKeepingBom,
  EXPECTED_COLUMNS,
  parseRfc4180,
  type CsvRecord,
} from '../helpers/csv';

const uuid = (n: number) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;

const receipt = (n: number) => ({
  receiptId: uuid(900 + n),
  fileName: `receipt-${n}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 2_048,
  sha256: 'a'.repeat(64),
  storageKey: `receipts/${n}`,
});

const line = (n: number, o: Partial<SnapshotLineV1> = {}): SnapshotLineV1 => ({
  lineItemId: uuid(100 + n),
  expenseDate: '2026-09-08',
  categoryId: uuid(200 + n),
  categoryCode: 'LODGING',
  categoryName: 'Lodging',
  glCode: '6110',
  amountMinor: 4_200_000,
  description: 'Hotel, 2 nights',
  merchant: 'Taj Residency',
  receipts: [],
  ...o,
});

/** One approved claim as the export reads it (C04-like: two lines on two GL codes). */
function claim(o: { snapshot?: Partial<SnapshotV1>; row?: Partial<ExportClaimRow> } = {}) {
  const lines = o.snapshot?.lines ?? [
    line(1, { receipts: [receipt(1), receipt(2)] }),
    line(2, {
      expenseDate: '2026-09-09',
      categoryCode: 'MEALS',
      categoryName: 'Meals',
      glCode: '6120',
      amountMinor: 5, // 5 paise: "0.05", never "0.5" or "5"
      description: 'Tea',
      merchant: null,
    }),
  ];
  const snapshot: SnapshotV1 = {
    v: 1,
    claimant: {
      id: uuid(1),
      employeeCode: 'E1001',
      name: 'Asha Rao',
      email: 'asha.rao@acme.test',
      departmentCode: 'ENG',
    },
    title: 'Client workshop, Pune',
    currency: 'INR',
    totalMinor: lines.reduce((s, l) => s + l.amountMinor, 0),
    ...o.snapshot,
    lines,
  };
  const row: ExportClaimRow = {
    id: uuid(4),
    claimNumber: 'EXP-2026-000004',
    revision: 2,
    approvedAt: new Date('2026-09-30T18:29:30.000Z'), // 30 Sep 23:59:30 IST (C09's instant)
    submittedAt: new Date('2026-09-11T04:35:00.000Z'), // 11 Sep 10:05 IST
    finalApproverEmail: 'meera.iyer@acme.test',
    snapshot,
    ...o.row,
  };
  return row;
}

/** claimToCsvRows output → records keyed by column (the output alone, no header). */
const recordsOf = (csv: string): CsvRecord[] =>
  parseRfc4180(csv).map((r) => {
    expect(r).toHaveLength(24);
    return Object.fromEntries(EXPECTED_COLUMNS.map((c, i) => [c, r[i]!])) as CsvRecord;
  });

const silent = pino({ level: 'silent' });

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  return chunks;
}
const concat = (chunks: Uint8Array[]) => new Uint8Array(Buffer.concat(chunks));

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('TC-U06 csv', () => {
  it('quotes fields per RFC 4180 and uses CRLF', () => {
    // Quote only when needed; double embedded quotes; line breaks stay inside the quotes
    expect(csvField('plain')).toBe('plain');
    expect(csvField('')).toBe('');
    expect(csvField('Hotel, 2 nights')).toBe('"Hotel, 2 nights"');
    expect(csvField('Taj "Residency"')).toBe('"Taj ""Residency"""');
    expect(csvField('"')).toBe('""""');
    expect(csvField('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvField('line 1\r\nline 2')).toBe('"line 1\r\nline 2"');
    expect(csvField('cr\ronly')).toBe('"cr\ronly"');
    expect(csvField("it's; fine\ttab")).toBe("it's; fine\ttab"); // no comma, quote or line break

    // A record is comma-separated and CRLF-terminated, empty fields included
    expect(csvLine(['a', 'b,c', '', 'd"e'])).toBe('a,"b,c",,"d""e"\r\n');
    expect(csvLine([''])).toBe('\r\n');

    // A claim's records round-trip through a strict RFC 4180 reader (which refuses bare LF/CR)
    const tricky = claim({
      snapshot: {
        title: 'Workshop, "Pune" edition',
        lines: [
          line(1, { description: 'Hotel, 2 nights\nlate checkout', merchant: 'Taj "Residency"' }),
          line(2, { description: 'Dinner\r\nfor 4', merchant: 'Cafe, Bar & Grill' }),
        ],
      },
    });
    const out = claimToCsvRows(tricky);
    expect(out.endsWith('\r\n')).toBe(true);
    const recs = recordsOf(out); // one record per line item, embedded line breaks and all
    expect(recs.map((r) => [r.line_no, r.claim_title, r.description, r.merchant])).toEqual([
      ['1', 'Workshop, "Pune" edition', 'Hotel, 2 nights\nlate checkout', 'Taj "Residency"'],
      ['2', 'Workshop, "Pune" edition', 'Dinner\r\nfor 4', 'Cafe, Bar & Grill'],
    ]);
    // Outside quoted fields, every line ends in CRLF: strip the quoted fields and look
    const unquoted = out.replace(/"(?:[^"]|"")*"/g, '');
    expect(unquoted).not.toMatch(/\r(?!\n)|(?<!\r)\n/);
    expect(unquoted.match(/\r\n/g)).toHaveLength(2);
  });

  it("prefixes ' to text starting with = + - @ TAB or CR, including after leading whitespace", () => {
    const payloads = [
      '=1+1',
      '=HYPERLINK("http://evil.example","Click")',
      '+91 98450 12345', // a real merchant phone number is still prefixed (README note)
      '-2+3',
      '@SUM(A1:A9)',
      '\tplain after a tab',
      '\t=cmd|"/c calc"!A1',
      '\rcarriage return',
      ' =1+1', // some spreadsheet apps trim before evaluating
      '   @SUM(A1)',
      '\t\t-1',
      '\n=1+1',
      ' \t +1',
    ];
    for (const p of payloads) expect([p, csvText(p)]).toEqual([p, `'${p}`]);

    // Through a whole claim: every text column we did not generate is guarded, then quoted if needed
    const evil = '=HYPERLINK("http://evil.example","x")';
    const escaped = claim({
      snapshot: {
        claimant: {
          id: uuid(1),
          employeeCode: '+E1001',
          name: '-2+3 Rao',
          email: '@asha.rao@acme.test',
          departmentCode: '=ENG',
        },
        title: ' =1+1 title',
        lines: [
          line(1, {
            categoryCode: '@LODGING',
            categoryName: '\tLodging',
            description: evil,
            merchant: '+91 98450 12345',
          }),
        ],
      },
      row: { finalApproverEmail: '=meera.iyer@acme.test' },
    });
    const out = claimToCsvRows(escaped);
    expect(out).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`); // guard, then RFC 4180
    const [rec] = recordsOf(out);
    expect({
      employee_code: rec!.employee_code,
      employee_name: rec!.employee_name,
      employee_email: rec!.employee_email,
      department_code: rec!.department_code,
      claim_title: rec!.claim_title,
      final_approver_email: rec!.final_approver_email,
      category_code: rec!.category_code,
      category_name: rec!.category_name,
      description: rec!.description,
      merchant: rec!.merchant,
    }).toEqual({
      employee_code: "'+E1001",
      employee_name: "'-2+3 Rao",
      employee_email: "'@asha.rao@acme.test",
      department_code: "'=ENG",
      claim_title: "' =1+1 title",
      final_approver_email: "'=meera.iyer@acme.test",
      category_code: "'@LODGING",
      category_name: "'\tLodging",
      description: `'${evil}`,
      merchant: "'+91 98450 12345",
    });
  });

  it('leaves safe text and generated columns unchanged', () => {
    const safe = [
      'Taxi to airport',
      'a=b',
      'x-y',
      'asha.rao@acme.test',
      '₹500 lunch',
      "O'Brien",
      ' leading space',
      'Ünïcödé café, Zürich',
      '100% done',
      '(+91) 98450',
      '1+1',
      '−5 (a Unicode minus, not a formula)',
      '',
    ];
    for (const s of safe) expect([s, csvText(s)]).toEqual([s, s]);
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');

    // Generated columns are written raw, in IST whatever the process zone is
    process.env.TZ = 'America/Los_Angeles';
    const c = claim();
    const recs = recordsOf(claimToCsvRows(c));
    const shared = {
      claim_number: 'EXP-2026-000004',
      claim_id: uuid(4),
      revision: '2',
      employee_code: 'E1001',
      employee_name: 'Asha Rao',
      employee_email: 'asha.rao@acme.test',
      department_code: 'ENG',
      claim_title: 'Client workshop, Pune',
      submitted_at: '2026-09-11T10:05:00.000+05:30',
      approved_at: '2026-09-30T23:59:30.000+05:30',
      posting_date: '2026-09-30',
      final_approver_email: 'meera.iyer@acme.test',
      currency: 'INR',
      claim_total: '42000.05',
    };
    expect(recs).toEqual([
      {
        ...shared,
        line_no: '1',
        line_item_id: uuid(101),
        expense_date: '2026-09-08',
        category_code: 'LODGING',
        category_name: 'Lodging',
        gl_code: '6110',
        description: 'Hotel, 2 nights',
        merchant: 'Taj Residency',
        amount: '42000.00',
        receipt_count: '2',
      },
      {
        ...shared,
        line_no: '2',
        line_item_id: uuid(102),
        expense_date: '2026-09-09',
        category_code: 'MEALS',
        category_name: 'Meals',
        gl_code: '6120',
        description: 'Tea',
        merchant: '', // null merchant → empty field
        amount: '0.05',
        receipt_count: '0',
      },
    ]);
    for (const r of recs) {
      expect(r.amount).toMatch(DECIMAL);
      expect(r.claim_total).toMatch(DECIMAL);
    }

    // Plain dot decimals at the extremes: no grouping, no exponent, no locale
    const big = recordsOf(
      claimToCsvRows(claim({ snapshot: { lines: [line(1, { amountMinor: 100_000_000 })] } })),
    );
    expect([big[0]!.amount, big[0]!.claim_total]).toEqual(['1000000.00', '1000000.00']);
    // The posting date is the IST date of the final approval: 00:00 IST on 1 Oct is October
    const midnight = recordsOf(
      claimToCsvRows(claim({ row: { approvedAt: new Date('2026-09-30T18:30:00.000Z') } })),
    );
    expect([midnight[0]!.approved_at, midnight[0]!.posting_date]).toEqual([
      '2026-10-01T00:00:00.000+05:30',
      '2026-10-01',
    ]);
  });

  it('starts the file with a UTF-8 BOM', async () => {
    expect(CSV_BOM).toBe('﻿');
    expect([...CSV_COLUMNS]).toEqual([...EXPECTED_COLUMNS]);
    const preamble = csvPreamble();
    expect(preamble).toBe(`﻿${EXPECTED_COLUMNS.join(',')}\r\n`);
    expect([...new TextEncoder().encode(preamble).subarray(0, 3)]).toEqual([...BOM_BYTES]);

    // An empty period: the stream is exactly BOM + header (a header-only file)
    const empty = concat(
      await drain(
        approvedClaimsCsvStream({ batchSize: 3, log: silent, fetchBatch: async () => [] }),
      ),
    );
    expect(decodeKeepingBom(empty)).toBe(preamble);
    expect(checkExportFile(empty).records).toEqual([]);

    // Across several keyset batches the BOM is still written once, first, and never per batch
    const claims = [1, 2, 3, 4, 5].map((n) =>
      claim({
        row: {
          id: uuid(10 + n),
          claimNumber: `EXP-2026-00001${n}`,
          approvedAt: new Date(`2026-09-1${n}T06:00:00.000Z`),
        },
      }),
    );
    const calls: (ExportCursor | null)[] = [];
    const chunks = await drain(
      approvedClaimsCsvStream({
        batchSize: 2,
        log: silent,
        fetchBatch: async (after) => {
          calls.push(after);
          const start = after ? claims.findIndex((c) => c.id === after.id) + 1 : 0;
          return claims.slice(start, start + 2);
        },
      }),
    );
    expect(chunks).toHaveLength(4); // the preamble, then one chunk per batch (2 + 2 + 1)
    expect([...chunks[0]!.subarray(0, 3)]).toEqual([...BOM_BYTES]);
    for (const chunk of chunks.slice(1))
      expect([...chunk.subarray(0, 3)]).not.toEqual([...BOM_BYTES]);
    const file = checkExportFile(concat(chunks));
    expect(file.records.map((r) => [r.claim_number, r.line_no])).toEqual(
      claims.flatMap((c) => [
        [c.claimNumber, '1'],
        [c.claimNumber, '2'],
      ]),
    );
    // The keyset position passed on is the last emitted claim's (approved_at, id)
    expect(calls).toEqual([
      null,
      { approvedAt: claims[1]!.approvedAt, id: claims[1]!.id },
      { approvedAt: claims[3]!.approvedAt, id: claims[3]!.id },
    ]);
  });
});
