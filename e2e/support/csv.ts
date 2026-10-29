/**
 * Reads the export CSV (C-22: UTF-8 with BOM, RFC 4180 quoting, CRLF) into one object per record,
 * keyed by the header row. Small and strict on purpose: a quoted cell may hold commas, quotes
 * ("") and line breaks, exactly what the writer produces.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);

  const [header = [], ...records] = rows;
  return records.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
