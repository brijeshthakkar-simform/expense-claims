import 'server-only';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReceiptStorage, StoredObject } from '@/server/storage/receipt-storage';

// 06 §5.3 / §5.9: the storage-gate fallback (RECEIPT_STORAGE_DRIVER=fs, a volume at
// RECEIPT_FS_DIR). Kept as an adapter although SeaweedFS passed the gate: services, routes and
// tests don't change when it is swapped in.

/** `receipts/{claimId}/{lineItemId}/{uuid}`: validated before any path is built (no traversal). */
export const RECEIPT_KEY_PATTERN = /^receipts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const isNotFound = (err: unknown) =>
  err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';

export class FsReceiptStorage implements ReceiptStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  private pathOf(key: string): string {
    if (!RECEIPT_KEY_PATTERN.test(key)) throw new Error('invalid receipt storage key');
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Uint8Array) {
    const target = this.pathOf(key);
    await mkdir(path.dirname(target), { recursive: true });
    // A temp file opened 'wx' (fails if it exists), then an atomic rename: a reader never sees a
    // half-written object. Keys are fresh UUIDs, so the rename never replaces evidence.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, body, { flag: 'wx' });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.pathOf(key);
    try {
      const { size } = await stat(file);
      return {
        sizeBytes: size,
        body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string) {
    await rm(this.pathOf(key), { force: true });
  }

  async ping() {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
