import 'server-only';
import { RECEIPT_TYPES } from '@/shared/policy';

// 06 §5.4: the declared Content-Type is a claim; the first bytes are evidence. A receipt is
// accepted only when both agree, and the SNIFFED type is what gets stored and served, so an .exe
// renamed to .pdf (it starts with "MZ") or an HTML page labelled image/png never gets in.

export type ReceiptContentType = (typeof RECEIPT_TYPES)[number];

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const PDF = ascii('%PDF-');

/** The allowlisted type the magic bytes prove, or null (not a receipt type we accept). */
export function sniffReceiptType(bytes: Uint8Array): ReceiptContentType | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

/** A declared MIME type, lower-cased and without parameters; null unless it is allowlisted. */
export function allowedDeclaredType(
  declared: string | null | undefined,
): ReceiptContentType | null {
  const t = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  return (RECEIPT_TYPES as readonly string[]).includes(t) ? (t as ReceiptContentType) : null;
}
