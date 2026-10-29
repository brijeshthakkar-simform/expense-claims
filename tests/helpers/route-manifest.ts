// The route inventory (04 §3.4, TC-I01). Routes are discovered from the file system, so a new
// route.ts is probed the moment it exists. EXPECTED_ROUTES only guards against a route vanishing:
// each phase appends its own keys (P1: 12; P2: 18; P3: 19; P4: 22; P5: 24; P6: 27; the finished
// app: 29). Never assert a count.
import { randomUUID } from 'node:crypto';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteHandler } from '@/server/http/define-route';
import type { Method } from './http';

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const EXPECTED_ROUTES = [
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/me',
  'GET /api/health/live',
  'GET /api/health/ready',
  ...METHODS.map((m) => `${m} /api/v1/[...path]`),
  // P2
  'GET /api/v1/categories',
  'GET /api/v1/claims',
  'POST /api/v1/claims',
  'GET /api/v1/claims/[claimId]',
  'PUT /api/v1/claims/[claimId]',
  'DELETE /api/v1/claims/[claimId]',
  // P3
  'POST /api/v1/claims/[claimId]/submit',
  // P4
  'POST /api/v1/claims/[claimId]/approve',
  'POST /api/v1/claims/[claimId]/reject',
  'GET /api/v1/approvals',
  // P5
  'POST /api/v1/claims/[claimId]/recall',
  'GET /api/v1/claims/[claimId]/history',
  // P6
  'POST /api/v1/claims/[claimId]/line-items/[lineItemId]/receipts',
  'GET /api/v1/claims/[claimId]/receipts/[receiptId]/content',
  'DELETE /api/v1/claims/[claimId]/receipts/[receiptId]',
  // P7
  'GET /api/v1/finance/claims',
  'GET /api/v1/finance/exports/approved-claims',
];

export interface Route {
  method: Method;
  /** e.g. `/api/v1/claims/[claimId]` (the folder path below src/app). */
  routePath: string;
  /** `METHOD /path`, the PUBLIC_ROUTES format. */
  key: string;
  handler: RouteHandler;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_DIR = path.join(ROOT, 'src/app');

/** Every exported method handler of every src/app/api/**\/route.ts. */
export async function loadRouteManifest(): Promise<Route[]> {
  const files: string[] = [];
  for await (const file of glob('api/**/route.ts', { cwd: APP_DIR })) files.push(file);
  files.sort();
  const perFile = await Promise.all(
    files.map(async (file) => {
      const mod = (await import(path.join(APP_DIR, file))) as Partial<Record<Method, RouteHandler>>;
      const routePath = `/${path.dirname(file).split(path.sep).join('/')}`;
      return METHODS.flatMap((method) => {
        const handler = mod[method];
        return handler ? [{ method, routePath, key: `${method} ${routePath}`, handler }] : [];
      });
    }),
  );
  return perFile.flat();
}

/**
 * A concrete URL and params for a route path: `[claimId]`-style segments become random UUIDs,
 * catch-alls (`[...path]`) become `nope`.
 */
export function materialise(routePath: string): {
  url: string;
  params: Record<string, string | string[]>;
} {
  const params: Record<string, string | string[]> = {};
  const url = routePath
    .split('/')
    .map((segment) => {
      const catchAll = /^\[\.\.\.(\w+)\]$/.exec(segment);
      if (catchAll) {
        params[catchAll[1]!] = ['nope'];
        return 'nope';
      }
      const dynamic = /^\[(\w+)\]$/.exec(segment);
      if (dynamic) {
        const id = randomUUID();
        params[dynamic[1]!] = id;
        return id;
      }
      return segment;
    })
    .join('/');
  return { url, params };
}
