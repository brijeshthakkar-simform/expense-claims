import { CURRENCY, MAX_LINE_AMOUNT_MINOR } from '@/shared/policy';

// 05 §13, D-09: money is integer paise on the wire and in the DB. Decimals exist only as strings,
// typed by a human or shown to one; string arithmetic means 0.29 is 29, never 28.999999999999996.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: CURRENCY });

/** 12345678 → "123456.78" (input values, CSV). */
export function toDecimalString(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Not a safe integer: ${minor}`);
  const sign = minor < 0 ? '-' : '';
  const abs = String(Math.abs(minor)).padStart(3, '0');
  return `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/** 12345678 → "₹1,23,456.78". Intl gets a decimal STRING, never a float. */
export const formatMinor = (minor: number): string =>
  inr.format(toDecimalString(minor) as Intl.StringNumericLiteral);

export type MoneyParseCode =
  'REQUIRED' | 'INVALID' | 'TOO_MANY_DECIMALS' | 'NOT_POSITIVE' | 'TOO_LARGE';
export type MoneyParse =
  { ok: true; value: number } | { ok: false; code: MoneyParseCode; message: string };

/**
 * What a person typed ("1,23,456.78", "₹450", "450.5") → integer paise. Spaces, commas and ₹ are
 * ignored (en-IN grouping); no sign, exponent, hex or bare ".5"; at most 2 decimals; 1..max.
 */
export function parseMoneyToMinor(raw: string, max = MAX_LINE_AMOUNT_MINOR): MoneyParse {
  const s = raw.replace(/[\s,₹]/g, '');
  if (s === '') return { ok: false, code: 'REQUIRED', message: 'Enter an amount' };
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return { ok: false, code: 'INVALID', message: 'Enter a number like 450 or 450.50' };
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > 2)
    return { ok: false, code: 'TOO_MANY_DECIMALS', message: 'Use at most 2 decimal places' };
  const tooLarge = {
    ok: false,
    code: 'TOO_LARGE',
    message: `Maximum per line is ${formatMinor(max)}`,
  } as const;
  if (whole.replace(/^0+/, '').length > 11) return tooLarge; // keeps the math below < 2^53
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (value <= 0)
    return { ok: false, code: 'NOT_POSITIVE', message: 'Amount must be greater than zero' };
  if (value > max) return tooLarge;
  return { ok: true, value };
}
