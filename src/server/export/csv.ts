import 'server-only';
import { businessDateOf, formatBusinessIso } from '@/shared/dates';
import type { SnapshotV1 } from '@/shared/dto/snapshot';
import { toDecimalString } from '@/shared/money';

// 06 §6.4–6.5, D-33, C-22: the bookkeeping CSV. One row per line item with the claim columns
// repeated; UTF-8 with BOM (Excel shows ₹ and non-ASCII names), RFC 4180 quoting, CRLF, comma,
// no locale formatting, no footer. Money stays integer paise until toDecimalString.

/** U+FEFF, the first character of every export file. */
export const CSV_BOM = '﻿';

/** C-22: the header row, in this order. */
export const CSV_COLUMNS = [
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
export type CsvColumn = (typeof CSV_COLUMNS)[number];

const FORMULA_START = /^[=+\-@]/;
const CONTROL_START = /^[\t\r]/;

/**
 * OWASP CSV-injection guard for every text column we did not generate (RT-m2): a value starting
 * with = + - @ (also after leading whitespace, which some spreadsheet apps trim before evaluating),
 * TAB or CR gets a leading `'`. User text is changed in exactly this one way.
 */
export function csvText(value: string | null | undefined): string {
  const v = value ?? '';
  return CONTROL_START.test(v) || FORMULA_START.test(v.trimStart()) ? `'${v}` : v;
}

/** RFC 4180: quote only when needed, double embedded quotes; line breaks stay inside quotes. */
export const csvField = (v: string): string =>
  /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;

/** One CSV record, CRLF-terminated. */
export const csvLine = (cells: readonly string[]): string => cells.map(csvField).join(',') + '\r\n';

/** The BOM plus the header row: the first chunk of every export, even an empty one. */
export const csvPreamble = (): string => CSV_BOM + csvLine(CSV_COLUMNS);

/** One approved claim as the export reads it: the approved submission's snapshot + its stamps. */
export interface ExportClaimRow {
  id: string;
  claimNumber: string;
  /** claims.current_revision = the approved revision. */
  revision: number;
  approvedAt: Date;
  /** The approved submission's submitted_at. */
  submittedAt: Date;
  /** The highest-level APPROVED step of that submission → users.email. */
  finalApproverEmail: string | null;
  snapshot: SnapshotV1;
}

/**
 * One claim → its CSV records (one per snapshot line, in snapshot order). Generated columns (ids,
 * claim number, revision, our ISO instants and dates, GL code, currency, amounts, counts) are
 * written raw; every name, email, title, code, description and merchant goes through csvText().
 */
export function claimToCsvRows(claim: ExportClaimRow): string {
  const s = claim.snapshot;
  const head = [
    claim.claimNumber,
    claim.id,
    String(claim.revision),
    csvText(s.claimant.employeeCode),
    csvText(s.claimant.name),
    csvText(s.claimant.email),
    csvText(s.claimant.departmentCode),
    csvText(s.title),
    formatBusinessIso(claim.submittedAt),
    formatBusinessIso(claim.approvedAt),
    businessDateOf(claim.approvedAt),
    csvText(claim.finalApproverEmail),
  ];
  const claimTotal = toDecimalString(s.totalMinor);
  return s.lines
    .map((l, i) =>
      csvLine([
        ...head,
        String(i + 1),
        l.lineItemId,
        l.expenseDate,
        csvText(l.categoryCode),
        csvText(l.categoryName),
        l.glCode,
        csvText(l.description),
        csvText(l.merchant),
        toDecimalString(l.amountMinor),
        s.currency,
        claimTotal,
        String(l.receipts.length),
      ]),
    )
    .join('');
}
