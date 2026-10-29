import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { getDb } from '@/server/db/client';

export interface RoleAttributes {
  roleName: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  ownsRelations: boolean;
  memberOfOwner: boolean;
}

/**
 * Attributes of the connected role (01 §9.2, proof H8). Exported as a Prisma.Sql so tests can run
 * the identical text through a pg client (`ROLE_ATTRIBUTES_SQL.text`). The owner-membership test
 * goes through pg_roles so a database without expense_owner reports false instead of raising.
 */
export const ROLE_ATTRIBUTES_SQL = Prisma.sql`
  SELECT r.rolname::text   AS "roleName",
         r.rolsuper        AS "isSuperuser",
         r.rolbypassrls    AS "bypassesRls",
         r.rolcreaterole   AS "canCreateRole",
         r.rolcreatedb     AS "canCreateDb",
         EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.relowner = r.oid
                    AND c.relnamespace = 'public'::regnamespace) AS "ownsRelations",
         EXISTS (SELECT 1 FROM pg_catalog.pg_roles o
                  WHERE o.rolname = 'expense_owner'
                    AND pg_catalog.pg_has_role(r.oid, o.oid, 'MEMBER')) AS "memberOfOwner"
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user`;

/**
 * Non-internal triggers in public that won't fire in a normal session: disabled ('D') or
 * replica-only ('R'). FK triggers are internal; our CONSTRAINT TRIGGERs are not. Must be 0.
 */
export const DISABLED_TRIGGERS_SQL = Prisma.sql`
  SELECT count(*)::int AS "disabledTriggers"
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND NOT t.tgisinternal
     AND t.tgenabled IN ('D', 'R')`;

export async function readRoleAttributes(): Promise<RoleAttributes> {
  const rows = await getDb().$queryRaw<RoleAttributes[]>(ROLE_ATTRIBUTES_SQL);
  const row = rows[0];
  if (!row) throw new Error('The connected database role was not found in pg_roles.');
  return row;
}

export async function countDisabledTriggers(): Promise<number> {
  const rows = await getDb().$queryRaw<{ disabledTriggers: number }[]>(DISABLED_TRIGGERS_SQL);
  return rows[0]?.disabledTriggers ?? 0;
}

/** Rejects after `ms`. The query itself is not cancelled; the role's statement_timeout bounds it. */
export function withTimeout<T>(
  work: PromiseLike<T>,
  ms: number,
  what = 'database call',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer));
}

/** SELECT 1 within `ms`. */
export async function ping(ms = 1_000): Promise<void> {
  await withTimeout(getDb().$queryRaw`SELECT 1`, ms, 'database ping');
}

/**
 * Readiness in one round trip: answering at all proves the DB is reachable within `ms`, and the
 * count says whether the integrity triggers are live.
 */
export async function readinessProbe(ms = 1_000): Promise<{ disabledTriggers: number }> {
  const disabledTriggers = await withTimeout(countDisabledTriggers(), ms, 'readiness probe');
  return { disabledTriggers };
}
