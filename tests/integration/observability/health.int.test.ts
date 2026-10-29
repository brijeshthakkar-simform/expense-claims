// TC-I06 (D-41, RT-B3): the probes, called in-process with a real NextRequest (07 §4), and the boot
// role check. The health routes are public and sit outside /api/v1.
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import * as readyRoute from '@/app/api/health/ready/route';
import { assertRuntimeRole } from '@/server/auth/runtime-role';
import { ROLE_ATTRIBUTES_SQL, type RoleAttributes } from '@/server/db/introspection';
import { ownerClient } from '../../helpers/db';

type Handler = (req: NextRequest) => Response | Promise<Response>;
const get = (route: { GET: Handler }, path: string) =>
  route.GET(new NextRequest(new URL(path, 'http://localhost:3000')));

describe('TC-I06 health and runtime role', () => {
  it('/api/health/live returns 200 without the DB', async () => {
    // Point the app at a port nothing listens on, then load the route on a fresh module graph so
    // env() and the client see that URL. If liveness touched the DB, this would fail.
    vi.stubEnv('DATABASE_URL', 'postgresql://expense_app:unused@127.0.0.1:9/expense_claims');
    vi.resetModules();
    try {
      const liveRoute = await import('@/app/api/health/live/route');
      const res = await get(liveRoute, '/api/health/live');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { status: 'live' } });
    } finally {
      // the fresh client module shares the globalThis pool slot: never leave a broken pool behind
      await (await import('@/server/db/client')).disconnectDb();
      vi.unstubAllEnvs();
    }
  });

  it('/api/health/ready returns 200 when the DB is up and triggers are enabled', async () => {
    const res = await get(readyRoute, '/api/health/ready');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { status: 'ready', checks: { db: 'ok', integrityTriggers: 'ok' } },
    });
  });

  it('/api/health/ready returns 503 NOT_READY when an integrity trigger is disabled', async () => {
    const owner = await ownerClient(); // only the owner can; expense_app gets 42501 (TC-I07)
    await owner.query(
      'ALTER TABLE line_items DISABLE TRIGGER line_items_20_recompute_after_insert',
    );
    try {
      const res = await get(readyRoute, '/api/health/ready');

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({ code: 'NOT_READY' });
      expect(JSON.stringify(body), 'failing checks go to the log, not the response').not.toMatch(
        /line_items|trigger/i,
      );
    } finally {
      await owner.query(
        'ALTER TABLE line_items ENABLE TRIGGER line_items_20_recompute_after_insert',
      );
    }
  });

  it('assertRuntimeRole rejects the owner role and accepts expense_app', async () => {
    // The same query the boot check runs, executed over an owner connection.
    const owner = await ownerClient();
    const [ownerAttributes] = (await owner.query<RoleAttributes>(ROLE_ATTRIBUTES_SQL.text)).rows;

    await expect(assertRuntimeRole(ownerAttributes)).rejects.toThrow(
      /connected as "expense_owner".*CREATEDB.*owns relations/,
    );
    await expect(assertRuntimeRole()).resolves.toBeUndefined(); // getDb() connects as expense_app
  });
});
