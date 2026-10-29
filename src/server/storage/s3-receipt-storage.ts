import 'server-only';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '@/server/env';
import type { ReceiptStorage, StoredObject } from '@/server/storage/receipt-storage';

// 06 §5.3: one INTERNAL client (S3_ENDPOINT = http://objectstore:8333 in compose). Path-style
// avoids `bucket.objectstore` DNS; the checksum settings stop SDK ≥ 3.729 sending CRC32 headers
// that third-party stores reject (both proven at the P6 storage gate against SeaweedFS 4.48).

const PING_TIMEOUT_MS = 1_000;

const httpStatusOf = (err: unknown): number | undefined =>
  err !== null && typeof err === 'object'
    ? (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;

/** The KEY is missing (a missing bucket is an outage, not a missing object). */
const isMissingKey = (err: unknown): boolean =>
  err instanceof Error &&
  err.name !== 'NoSuchBucket' &&
  (err.name === 'NoSuchKey' || err.name === 'NotFound' || httpStatusOf(err) === 404);

export class S3ReceiptStorage implements ReceiptStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(e: Readonly<Env>) {
    if (!e.S3_ENDPOINT || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY)
      throw new Error('S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
    this.bucket = e.S3_BUCKET;
    this.client = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
      // A dead store fails the receipt route (503), never hangs it.
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 30_000 },
    });
  }

  async put(key: string, body: Uint8Array, meta: { contentType: string; sha256: string }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: meta.contentType,
        ContentLength: body.byteLength,
        Metadata: { sha256: meta.sha256 },
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!r.Body) return null;
      return {
        body: r.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        sizeBytes: r.ContentLength ?? 0,
      };
    } catch (err) {
      if (isMissingKey(err)) return null;
      throw err;
    }
  }

  async delete(key: string) {
    // S3 DeleteObject succeeds for a missing key: idempotent by the protocol.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      return true;
    } catch {
      return false;
    }
  }
}
