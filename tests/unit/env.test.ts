// TC-U11 (§6-8, RT-B3, RT-m7): configuration fails fast and names the variable, demo shortcuts can't
// reach staging or production, and the app process refuses owner/superuser material (01 §9, D-34).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoForbiddenEnv } from '@/server/auth/runtime-role';
import { FORBIDDEN_IN_APP, forbiddenEnvPresent, parseEnv } from '@/server/env';
import { assertCastAllowed } from '../../prisma/seed-personas';

const DATABASE_URL = 'postgresql://expense_app:app-secret-pw@localhost:5432/expense_claims';
const LOCAL = { DATABASE_URL, RECEIPT_STORAGE_DRIVER: 'memory' };
const DEPLOYED = (appEnv: 'staging' | 'production') => ({
  APP_ENV: appEnv,
  APP_BASE_URL: 'https://claims.acme.example',
  DATABASE_URL,
  RECEIPT_STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://s3.acme.example',
  S3_ACCESS_KEY_ID: 'receipts',
  S3_SECRET_ACCESS_KEY: 's3-secret-key',
});

/** The thrown message, so assertions can check what it names and what it must not echo. */
function thrownBy(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}
/** A plain record as the env source (Next's ProcessEnv typing insists on NODE_ENV). */
type Source = Record<string, string | undefined>;
const parse = (source: Source) => parseEnv(source as NodeJS.ProcessEnv);
const failureOf = (source: Source): string => thrownBy(() => parse(source));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('TC-U11 env', () => {
  it('invalid env makes env() throw with the variable name', async () => {
    vi.stubEnv('DATABASE_URL', 'mysql://root:hunter2-secret@db/expense');
    vi.stubEnv('APP_BASE_URL', 'not-a-url');
    vi.stubEnv('SESSION_IDLE_TIMEOUT_MINUTES', '2');
    vi.resetModules();
    // Importing never throws (so `next build` works with no env); the first env() call does.
    const { env } = await import('@/server/env');

    const message = thrownBy(() => env());
    expect(message).toMatch(/^Invalid environment configuration/);
    for (const name of ['DATABASE_URL', 'APP_BASE_URL', 'SESSION_IDLE_TIMEOUT_MINUTES'])
      expect(message).toContain(name);
    expect(message).not.toContain('hunter2-secret'); // names the variable, never its value

    expect(failureOf({ ...LOCAL, DATABASE_URL: undefined })).toContain('DATABASE_URL');
    expect(failureOf({ ...LOCAL, LOG_LEVEL: 'verbose' })).toContain('LOG_LEVEL');
    expect(failureOf({ ...LOCAL, RECEIPT_STORAGE_DRIVER: 's3' })).toMatch(/S3_ENDPOINT/);
    expect(parse({ ...LOCAL, SEED_ON_START: '' }).SEED_ON_START).toBe(false); // '' is unset
  });

  it('staging and production reject SEED_ON_START=true, DEMO_MODE=true or a SEED_DEMO_PASSWORD', () => {
    const demoPassword = 'demo-pass-1234';
    for (const appEnv of ['staging', 'production'] as const) {
      expect(parse(DEPLOYED(appEnv)).APP_ENV).toBe(appEnv); // the positive control parses

      expect(failureOf({ ...DEPLOYED(appEnv), SEED_ON_START: 'true' })).toContain('SEED_ON_START');
      expect(failureOf({ ...DEPLOYED(appEnv), DEMO_MODE: 'true' })).toContain('DEMO_MODE');
      const leaked = failureOf({ ...DEPLOYED(appEnv), SEED_DEMO_PASSWORD: demoPassword });
      expect(leaked).toContain('SEED_DEMO_PASSWORD');
      expect(leaked).not.toContain(demoPassword);
      expect(
        failureOf({ ...DEPLOYED(appEnv), APP_BASE_URL: 'http://claims.acme.example' }),
      ).toContain('APP_BASE_URL');
      // The seed refuses the demo cast there too, whatever the env file says.
      expect(() => assertCastAllowed(appEnv)).toThrow(`APP_ENV=${appEnv}`);
    }

    // Local and test allow all three (the compose demo needs them).
    const demo = {
      ...LOCAL,
      SEED_ON_START: 'true',
      DEMO_MODE: 'true',
      SEED_DEMO_PASSWORD: demoPassword,
    };
    for (const appEnv of ['local', 'test']) {
      expect(parse({ ...demo, APP_ENV: appEnv })).toMatchObject({
        SEED_ON_START: true,
        DEMO_MODE: true,
      });
      expect(() => assertCastAllowed(appEnv)).not.toThrow();
    }
  });

  it('the forbidden owner and superuser variables are detected in production mode', () => {
    expect(FORBIDDEN_IN_APP).toEqual(
      expect.arrayContaining(['MIGRATE_DATABASE_URL', 'DB_OWNER_PASSWORD', 'POSTGRES_PASSWORD']),
    );
    for (const name of FORBIDDEN_IN_APP) {
      const source = { NODE_ENV: 'production', [name]: 'owner-secret-value' } as NodeJS.ProcessEnv;
      expect(forbiddenEnvPresent(source)).toEqual([name]);
      const message = thrownBy(() => assertNoForbiddenEnv(source));
      expect(message).toContain(name);
      expect(message).not.toContain('owner-secret-value');
    }

    const all = Object.fromEntries(FORBIDDEN_IN_APP.map((k) => [k, 'x']));
    expect(() => assertNoForbiddenEnv({ ...all, NODE_ENV: 'production' })).toThrow(
      new RegExp(FORBIDDEN_IN_APP.join(', ')),
    );
    // Empty counts as unset (compose's `${VAR:-}`), and `pnpm dev` is exempt by design.
    expect(() =>
      assertNoForbiddenEnv({ NODE_ENV: 'production', MIGRATE_DATABASE_URL: '' }),
    ).not.toThrow();
    expect(() => assertNoForbiddenEnv({ ...all, NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertNoForbiddenEnv({ NODE_ENV: 'production', DATABASE_URL })).not.toThrow();
  });
});
