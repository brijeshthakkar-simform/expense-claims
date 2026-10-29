import 'server-only';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    APP_VERSION: z.string().min(1).default('dev'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url().refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgres URL'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(480).default(60),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    DEMO_MODE: bool.default(false),
    RECEIPT_STORAGE_DRIVER: z.enum(['s3', 'fs', 'memory']).default('s3'),
    RECEIPT_FS_DIR: z.string().default('./.data/receipts'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(3).max(63).default('receipts'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(8).optional(),
    EXPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500), // tests use 3 to cross batch boundaries
    SEED_ON_START: bool.default(false),
    SEED_DEMO_PASSWORD: z.string().min(8).optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (key: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [key], message });
    if (e.RECEIPT_STORAGE_DRIVER === 's3')
      for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)
        if (!e[k]) fail(k, 'required when RECEIPT_STORAGE_DRIVER=s3');
    // RT-m7: demo data and demo shortcuts never leak out of local/test.
    if (e.APP_ENV === 'staging' || e.APP_ENV === 'production') {
      if (e.SEED_ON_START) fail('SEED_ON_START', 'must be false in staging/production');
      if (e.DEMO_MODE) fail('DEMO_MODE', 'must be false in staging/production');
      if (e.SEED_DEMO_PASSWORD !== undefined)
        fail('SEED_DEMO_PASSWORD', 'must be absent in staging/production');
      if (!e.APP_BASE_URL.startsWith('https://'))
        fail('APP_BASE_URL', 'must be https in staging/production');
      if (e.RECEIPT_STORAGE_DRIVER === 'memory')
        fail('RECEIPT_STORAGE_DRIVER', 'memory loses evidence on restart');
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Pure parse, exported for TC-U11. Empty strings count as unset, so compose's `FOO=${FOO:-}`
 * behaves like an absent variable. Errors name the variables, never their values.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Readonly<Env> {
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const r = EnvSchema.safeParse(present);
  if (!r.success) {
    const lines = r.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return Object.freeze(r.data);
}

let cached: Readonly<Env> | undefined;

/** Lazy and memoized: importing this module never throws, so `next build` works with zero env. */
export function env(): Readonly<Env> {
  return (cached ??= parseEnv(process.env));
}

/** D-34: owner/superuser material must never reach the app process. */
export const FORBIDDEN_IN_APP = [
  'MIGRATE_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'POSTGRES_PASSWORD',
  'DB_OWNER_PASSWORD',
  'DB_APP_PASSWORD',
  'SEED_DEMO_PASSWORD',
] as const;

export const forbiddenEnvPresent = (src: NodeJS.ProcessEnv = process.env) =>
  FORBIDDEN_IN_APP.filter((k) => (src[k] ?? '') !== '');
