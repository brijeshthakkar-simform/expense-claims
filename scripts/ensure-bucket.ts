// Ensures the receipts bucket exists (06 §5.2, 01 §10.3). Runs as the last step of the migrate
// job's `release` (docker/tools/entrypoint.sh), and on the host with `pnpm exec tsx
// scripts/ensure-bucket.ts`. Idempotent: HeadBucket, retried with backoff for up to 60 s while
// the object store starts, then CreateBucket only if the bucket is missing. No CORS in core: the
// app proxies every byte. A no-op for the fs and memory drivers.
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd()); // host runs read .env; in compose the real env wins

const DEADLINE_MS = 60_000;
const log = (msg: string) => console.log(`[ensure-bucket] ${msg}`);

const driver = process.env.RECEIPT_STORAGE_DRIVER || 's3';
if (driver !== 's3') {
  log(`skipped (RECEIPT_STORAGE_DRIVER=${driver})`);
  process.exit(0);
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`[ensure-bucket] ${name} is required when RECEIPT_STORAGE_DRIVER=s3`);
    process.exit(1);
  }
  return value;
};

const endpoint = required('S3_ENDPOINT');
const bucket = process.env.S3_BUCKET || 'receipts';
const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 1, // the loop below owns retries
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
});

const statusOf = (err: unknown): number | undefined =>
  err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
const describe = (err: unknown): string =>
  err instanceof Error
    ? `${err.name}${statusOf(err) ? ` (HTTP ${statusOf(err)})` : ''}`
    : String(err);

/** true = exists, false = missing; throws anything else (store not up yet, bad credentials). */
async function bucketExists(): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    if (statusOf(err) === 404 || (err instanceof Error && err.name === 'NotFound')) return false;
    throw err;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      if (await bucketExists()) {
        log(`bucket "${bucket}" exists at ${endpoint}`);
        return;
      }
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (err) {
        // Another runner won the race: that is success too.
        if (!(err instanceof Error) || !/BucketAlready(OwnedByYou|Exists)/.test(err.name))
          throw err;
      }
      log(`bucket "${bucket}" created at ${endpoint}`);
      return;
    } catch (err) {
      const elapsed = Date.now() - started;
      if (elapsed >= DEADLINE_MS) {
        console.error(
          `[ensure-bucket] gave up after ${Math.round(elapsed / 1000)} s: ${describe(err)}` +
            (statusOf(err) === 403 ? ' (check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)' : ''),
        );
        process.exit(1);
      }
      const wait = Math.min(500 * 2 ** (attempt - 1), 5_000);
      log(`object store not ready (${describe(err)}); retrying in ${wait} ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

await main();
client.destroy();
