import 'server-only';
import type { ReceiptStorage, StoredObject } from '@/server/storage/receipt-storage';

// 06 §5.3: the integration-test adapter (RECEIPT_STORAGE_DRIVER=memory). A Map, plus the
// inspection and fault hooks the tests need ("a failed DB insert deletes the uploaded object",
// "deleting a receipt on a previously submitted claim keeps the object", orphan logging).

export interface MemoryObject {
  body: Uint8Array;
  contentType: string;
  sha256: string;
}

export interface MemoryStorageFaults {
  /** Thrown by the next put/get/delete calls while set. */
  put?: Error;
  get?: Error;
  delete?: Error;
  /** ping() reports false while set. */
  ping?: boolean;
}

export class MemoryReceiptStorage implements ReceiptStorage {
  private readonly objects = new Map<string, MemoryObject>();
  /** Set a field to make that operation fail; clear() resets them. */
  faults: MemoryStorageFaults = {};
  /** Runs after an object is stored (e.g. to change the claim before the upload's DB transaction). */
  onPut: ((key: string) => void | Promise<void>) | undefined;

  async put(key: string, body: Uint8Array, meta: { contentType: string; sha256: string }) {
    if (this.faults.put) throw this.faults.put;
    this.objects.set(key, {
      body: body.slice(),
      contentType: meta.contentType,
      sha256: meta.sha256,
    });
    await this.onPut?.(key);
  }

  async get(key: string): Promise<StoredObject | null> {
    if (this.faults.get) throw this.faults.get;
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.body.slice();
    return {
      sizeBytes: bytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  async delete(key: string) {
    if (this.faults.delete) throw this.faults.delete;
    this.objects.delete(key);
  }

  async ping() {
    return !this.faults.ping;
  }

  // ---------------------------------------------------------------------- test inspection

  /** Every stored key, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** The stored object (a copy), or undefined. */
  read(key: string): MemoryObject | undefined {
    const o = this.objects.get(key);
    return o && { ...o, body: o.body.slice() };
  }

  get size(): number {
    return this.objects.size;
  }

  /** resetDb() calls this before every integration test: no objects, faults or hooks survive. */
  clear(): void {
    this.objects.clear();
    this.faults = {};
    this.onPut = undefined;
  }
}
