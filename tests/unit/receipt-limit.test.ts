// C-14 receipt size limit: NEXT_PUBLIC_RECEIPT_MAX_BYTES lowers the 10 MiB default for a host with a
// smaller request-body cap (Vercel: 4.5 MB) but can never raise it, because the DB CHECK
// receipts_size_range allows 1..10485760. Anything but a plain base-10 integer in range is ignored.
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEN_MIB = 10_485_760;
const FOUR_MIB = 4_194_304;

/** `load()` on freshly reset modules, with the variable set to `value` (undefined = unset). */
async function importWith<T>(value: string | undefined, load: () => Promise<T>): Promise<T> {
  vi.stubEnv('NEXT_PUBLIC_RECEIPT_MAX_BYTES', value);
  vi.resetModules();
  return load();
}
const limitWith = async (value: string | undefined) =>
  (await importWith(value, () => import('@/shared/policy'))).RECEIPT_MAX_BYTES;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('RECEIPT_MAX_BYTES from NEXT_PUBLIC_RECEIPT_MAX_BYTES', () => {
  it('is 10 MiB when the variable is unset', async () => {
    expect(await limitWith(undefined)).toBe(TEN_MIB);
  });

  describe('accepts a plain base-10 integer from 1 up to the 10 MiB ceiling', () => {
    it.each([
      ['4194304', FOUR_MIB],
      ['10485760', TEN_MIB],
      ['1', 1],
    ])('%s gives %i bytes', async (raw, bytes) => {
      expect(await limitWith(raw)).toBe(bytes);
    });
  });

  describe('falls back to the 10 MiB default for anything else', () => {
    it.each([
      ['one byte over the ceiling', '10485761'],
      ['far over the ceiling', '99999999999999999999'],
      ['zero', '0'],
      ['negative', '-1'],
      ['decimal', '4.5'],
      ['exponent', '1e6'],
      ['hexadecimal', '0x10'],
      ['leading whitespace', ' 4194304'],
      ['trailing whitespace', '4194304 '],
      ['trailing newline', '4194304\n'],
      ['leading plus', '+4194304'],
      ['leading zero', '04194304'],
      ['empty string', ''],
      ['text', 'abc'],
    ])('%s (%j)', async (_case, raw) => {
      expect(await limitWith(raw)).toBe(TEN_MIB);
    });
  });
});

describe('receipt size copy follows RECEIPT_MAX_BYTES', () => {
  const overLimit = (bytes: number) =>
    new File([new Uint8Array(bytes + 1)], 'receipt.pdf', { type: 'application/pdf' });

  it.each([
    ['unset (10 MiB)', undefined, TEN_MIB, '10 MB'],
    ['4 MiB', '4194304', FOUR_MIB, '4 MB'],
    ['a non-whole MiB rounds down', '5000000', 5_000_000, '4.7 MB'],
  ])('%s', async (_case, raw, bytes, label) => {
    const upload = await importWith(raw, () => import('@/features/claims/receipts/upload'));
    expect(upload.RECEIPT_MAX_LABEL).toBe(label);
    expect(upload.checkReceiptFile(overLimit(bytes))).toBe(
      `This file is too large. Receipts must be ${label} or smaller.`,
    );
  });
});
