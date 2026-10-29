import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// TC-E06 (07 §11): §6-8, RT-B3, RT-m6. The stack `docker compose up --build --wait` started is
// healthy, the one-shot release job succeeded, and the app container holds the runtime role's
// credentials only: no owner or superuser variable or value, a non-root user, loopback ports.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', ...args], { cwd: repoRoot, encoding: 'utf8' });

const FORBIDDEN = [
  'MIGRATE_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'PERF_DATABASE_URL',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'DB_OWNER_PASSWORD',
  'DB_APP_PASSWORD',
  'SEED_DEMO_PASSWORD',
];

interface PsRow {
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

test('a clean docker compose up is healthy and the app container holds no owner or superuser credentials', async ({
  request,
}) => {
  const ready = await request.get('/api/health/ready');
  expect(ready.status()).toBe(200);
  expect(((await ready.json()) as { data: unknown }).data).toMatchObject({
    status: 'ready',
    checks: { db: 'ok', integrityTriggers: 'ok' },
  });

  // `ps --format json` prints one JSON object per line (Compose v2.21+).
  const ps = compose('ps', '--all', '--format', 'json')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as PsRow);
  const svc = (name: string) => ps.find((s) => s.Service === name);
  expect(svc('migrate'), 'the one-shot release job succeeded').toMatchObject({
    State: 'exited',
    ExitCode: 0,
  });
  // The storage-gate fallback (06 §5.9) runs without the object store.
  const fsFallback = process.env.RECEIPT_STORAGE_DRIVER === 'fs';
  const longRunning = ['postgres', 'app', ...(fsFallback ? [] : ['objectstore'])];
  for (const name of longRunning) {
    expect(svc(name), `${name} is running`).toMatchObject({ State: 'running' });
    expect(svc(name)?.Health, `${name} is healthy`).toBe('healthy');
  }

  const env = compose('exec', '-T', 'app', 'env');
  for (const name of FORBIDDEN) expect(env, name).not.toMatch(new RegExp(`^${name}=`, 'm'));
  // No owner or superuser secret under another name either (values from the host's .env).
  for (const name of ['DB_OWNER_PASSWORD', 'POSTGRES_PASSWORD', 'SEED_DEMO_PASSWORD']) {
    const secret = process.env[name];
    if (secret) expect(env.includes(secret), `the value of ${name}`).toBe(false);
  }
  expect(env).not.toMatch(/expense_owner/);
  expect(env).toMatch(/^DATABASE_URL=postgresql:\/\/expense_app:/m); // the runtime role only
  expect(env).toMatch(/^NODE_ENV=production$/m);
  expect(compose('exec', '-T', 'app', 'id', '-u').trim(), 'non-root runner').toBe('1000');

  // RT-m6: every published port is bound to loopback.
  const ports: [string, string][] = [
    ['app', '3000'],
    ['postgres', '5432'],
    ...(fsFallback ? [] : ([['objectstore', '8333']] as [string, string][])),
  ];
  for (const [service, port] of ports) {
    expect(compose('port', service, port).trim(), `${service}:${port}`).toMatch(/^127\.0\.0\.1:/);
  }
});
