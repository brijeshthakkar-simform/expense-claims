// TC-U01 (§3.1 amounts, D-09): money is integer paise; decimals exist only as strings typed by a
// person or shown to one, so string arithmetic never drifts (05 §13, 04 §10.4).
import { describe, expect, it } from 'vitest';
import { formatMinor, parseMoneyToMinor, toDecimalString } from '@/shared/money';
import { MAX_LINE_AMOUNT_MINOR } from '@/shared/policy';

const minor = (raw: string): number => {
  const r = parseMoneyToMinor(raw);
  if (!r.ok) throw new Error(`${raw}: ${r.code}`);
  return r.value;
};
const failure = (raw: string) => {
  const r = parseMoneyToMinor(raw);
  return r.ok ? `ok:${r.value}` : r.code;
};

describe('TC-U01 money', () => {
  it("parseMoneyToMinor('0.29') returns 29 (no float drift)", () => {
    expect(0.29 * 100).not.toBe(29); // the bug this avoids: 28.999999999999996
    expect(minor('0.29')).toBe(29);
    expect(Number.isSafeInteger(minor('0.29'))).toBe(true);
    for (const [raw, want] of [
      ['0.57', 57],
      ['1.10', 110],
      ['1.1', 110],
      ['19.99', 1999],
      ['4.35', 435],
      ['450', 45_000],
      ['0.01', 1],
      ['10,00,000.00', MAX_LINE_AMOUNT_MINOR],
    ] as const)
      expect([raw, minor(raw)]).toEqual([raw, want]);
  });

  it('parseMoneyToMinor rejects 3 decimal places, negatives, exponent notation and empty input', () => {
    expect(failure('1.234')).toBe('TOO_MANY_DECIMALS');
    expect(failure('0.001')).toBe('TOO_MANY_DECIMALS');
    expect(failure('-5')).toBe('INVALID');
    expect(failure('-0.50')).toBe('INVALID');
    expect(failure('1e3')).toBe('INVALID');
    expect(failure('1E-2')).toBe('INVALID');
    expect(failure('')).toBe('REQUIRED');
    expect(failure('   ')).toBe('REQUIRED');
    // and the rest of the junk a person (or a paste) can produce
    expect(failure('.5')).toBe('INVALID');
    expect(failure('0x10')).toBe('INVALID');
    expect(failure('12abc')).toBe('INVALID');
    expect(failure('0')).toBe('NOT_POSITIVE');
    expect(failure('0.00')).toBe('NOT_POSITIVE');
    expect(failure('10,00,000.01')).toBe('TOO_LARGE');
    expect(failure('999999999999999999')).toBe('TOO_LARGE');
  });

  it('parseMoneyToMinor accepts en-IN grouping like 1,23,456.78', () => {
    expect(minor('1,23,456.78')).toBe(12_345_678);
    expect(minor('₹1,23,456.78')).toBe(12_345_678);
    expect(minor(' 1,250.5 ')).toBe(125_050);
    expect(minor('123456.78')).toBe(12_345_678);
  });

  it('formatMinor(12345678) renders ₹1,23,456.78', () => {
    expect(formatMinor(12_345_678)).toBe('₹1,23,456.78');
    expect(formatMinor(30)).toBe('₹0.30');
    expect(formatMinor(MAX_LINE_AMOUNT_MINOR)).toBe('₹10,00,000.00');
    expect(toDecimalString(12_345_678)).toBe('123456.78');
    expect(toDecimalString(5)).toBe('0.05');
  });

  it('sum of 0.10 + 0.20 in minor units is 30', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // floats drift …
    const sum = minor('0.10') + minor('0.20'); // … integers can't
    expect(sum).toBe(30);
    expect(formatMinor(sum)).toBe('₹0.30');
  });
});
