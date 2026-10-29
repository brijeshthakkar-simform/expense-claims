// Reading the finance export in tests (TC-U06, TC-I28). The parser is written from RFC 4180, not
// borrowed from src/server/export, so the tests don't grade the code with its own answers.
import { expect } from 'vitest';

/** C-22 / 06 §6.4: the 24 header names, in order (written out from the contract). */
export const EXPECTED_COLUMNS = [
  'claim_number',
  'claim_id',
  'revision',
  'employee_code',
  'employee_name',
  'employee_email',
  'department_code',
  'claim_title',
  'submitted_at',
  'approved_at',
  'posting_date',
  'final_approver_email',
  'line_no',
  'line_item_id',
  'expense_date',
  'category_code',
  'category_name',
  'gl_code',
  'description',
  'merchant',
  'amount',
  'currency',
  'claim_total',
  'receipt_count',
] as const;
export type Column = (typeof EXPECTED_COLUMNS)[number];
export type CsvRecord = Record<Column, string>;

/** The UTF-8 encoding of U+FEFF. */
export const BOM_BYTES = [0xef, 0xbb, 0xbf] as const;
export const DECIMAL = /^\d+\.\d{2}$/;

/** UTF-8 decode that KEEPS a leading BOM (`res.text()` and the default TextDecoder strip it). */
export const decodeKeepingBom = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);

/**
 * RFC 4180 records of `text` (no BOM). Throws on anything a strict reader would refuse: a bare LF
 * or CR outside quotes, a quote inside an unquoted field, text after a closing quote, an
 * unterminated quote or a missing final CRLF. Returns every record including the header.
 */
export function parseRfc4180(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  if (text.length === 0) return records;
  for (;;) {
    let field = '';
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= text.length) throw new Error('unterminated quoted field');
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i++];
      }
    } else {
      while (i < text.length && !',\r\n'.includes(text[i]!)) {
        if (text[i] === '"') throw new Error(`bare quote in an unquoted field at ${i}`);
        field += text[i++];
      }
    }
    record.push(field);
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text.startsWith('\r\n', i)) {
      records.push(record);
      record = [];
      i += 2;
      if (i === text.length) return records;
      continue;
    }
    if (i >= text.length) throw new Error('the last record has no CRLF');
    throw new Error(`bare ${JSON.stringify(text[i])} outside quotes at ${i}`);
  }
}

export interface ExportFile {
  bytes: Uint8Array;
  /** Decoded with the BOM kept. */
  text: string;
  header: string[];
  records: CsvRecord[];
}

/**
 * The P7 file-format checks every TC-I28 case runs on a CSV body (07 §6.2 notes): the UTF-8 BOM
 * (once, first), CRLF line ends only, the 24 C-22 columns in order, 24 fields per record, and
 * `amount` / `claim_total` matching ^\d+\.\d{2}$.
 */
export function checkExportFile(bytes: Uint8Array): ExportFile {
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([...BOM_BYTES]);
  const text = decodeKeepingBom(bytes);
  expect(text.indexOf('\uFEFF', 1), 'the BOM appears once, at the start').toBe(-1);
  const all = parseRfc4180(text.slice(1)); // throws on any bare LF / CR or a missing final CRLF
  const [header, ...rows] = all;
  expect(header).toEqual([...EXPECTED_COLUMNS]);
  const records = rows.map((r) => {
    expect(r).toHaveLength(EXPECTED_COLUMNS.length);
    const rec = Object.fromEntries(EXPECTED_COLUMNS.map((c, i) => [c, r[i]!])) as CsvRecord;
    expect(rec.amount).toMatch(DECIMAL);
    expect(rec.claim_total).toMatch(DECIMAL);
    return rec;
  });
  return { bytes, text, header: header!, records };
}

/** Reads a 200 CSV response body as bytes and runs checkExportFile on it. */
export async function readExport(res: Response): Promise<ExportFile> {
  expect(res.status).toBe(200);
  return checkExportFile(new Uint8Array(await res.arrayBuffer()));
}
