import 'server-only';
import { randomUUID } from 'node:crypto';
import { env } from '@/server/env';
import { FsReceiptStorage, RECEIPT_KEY_PATTERN } from '@/server/storage/fs-receipt-storage';
import { MemoryReceiptStorage } from '@/server/storage/memory-receipt-storage';
import { S3ReceiptStorage } from '@/server/storage/s3-receipt-storage';

// 06 §5.3 (D-30): the services speak put/get/delete/ping and nothing above src/server/storage
// knows which store is in use. SeaweedFS (s3) locally and AWS S3 in production use the same
// adapter; the FS adapter is the storage-gate fallback; Memory is for the integration tests.

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  sizeBytes: number;
}

export interface ReceiptStorage {
  /** Writes a fresh key. Never called inside a DB transaction (D-14). */
  put(key: string, body: Uint8Array, meta: { contentType: string; sha256: string }): Promise<void>;
  /** `null` = no such key. */
  get(key: string): Promise<StoredObject | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** ≤ 1 s, for readiness; never throws. */
  ping(): Promise<boolean>;
}

// The memo lives on globalThis (like the Prisma pool) so a test that re-imports modules still
// shares one MemoryReceiptStorage with resetDb().
const slot = globalThis as typeof globalThis & { __expenseReceiptStorage?: ReceiptStorage };

/**
 * The configured adapter, chosen by RECEIPT_STORAGE_DRIVER. Lazy and memoized: importing this
 * module reads no env, so `next build` works with zero configuration.
 */
export function getStorage(): ReceiptStorage {
  return (slot.__expenseReceiptStorage ??= createStorage());
}

function createStorage(): ReceiptStorage {
  const e = env();
  switch (e.RECEIPT_STORAGE_DRIVER) {
    case 's3':
      return new S3ReceiptStorage(e);
    case 'fs':
      return new FsReceiptStorage(e.RECEIPT_FS_DIR);
    case 'memory':
      return new MemoryReceiptStorage();
  }
}

/**
 * Tests only: swap in another adapter (e.g. a faulty one), or pass `undefined` to fall back to
 * the configured driver on the next getStorage().
 */
export function setStorageForTests(storage: ReceiptStorage | undefined): void {
  slot.__expenseReceiptStorage = storage;
}

export { RECEIPT_KEY_PATTERN };

/**
 * `receipts/{claimId}/{lineItemId}/{uuid}`: fresh on every upload, so an existing object is never
 * overwritten, and it holds no file name or PII (06 §5.4).
 */
export const newReceiptKey = (claimId: string, lineItemId: string): string =>
  `receipts/${claimId}/${lineItemId}/${randomUUID()}`;
