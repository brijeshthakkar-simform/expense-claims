import 'server-only';
import { readRoleAttributes, type RoleAttributes } from '@/server/db/introspection';
import { forbiddenEnvPresent } from '@/server/env';

/** Fixed role names (D-34): the triggers compare current_user with 'expense_app'. */
export const APP_ROLE = 'expense_app';
export const OWNER_ROLE = 'expense_owner';

/**
 * Why the connected role could switch the DB guards off, or skip the DB-owned stamping that the
 * triggers apply only to expense_app. Empty means the role is safe to serve traffic with.
 */
export function runtimeRoleViolations(a: RoleAttributes): string[] {
  const v: string[] = [];
  if (a.roleName !== APP_ROLE) v.push(`connected as "${a.roleName}", not ${APP_ROLE}`);
  if (a.isSuperuser) v.push('SUPERUSER');
  if (a.bypassesRls) v.push('BYPASSRLS');
  if (a.canCreateRole) v.push('CREATEROLE');
  if (a.canCreateDb) v.push('CREATEDB');
  if (a.ownsRelations) v.push('owns relations in schema public');
  if (a.memberOfOwner) v.push(`member of ${OWNER_ROLE}`);
  return v;
}

/** D-34 (2), every environment: the app's own connection must be least-privilege. */
export async function assertRuntimeRole(attrs?: RoleAttributes): Promise<void> {
  const a = attrs ?? (await readRoleAttributes());
  const v = runtimeRoleViolations(a);
  if (v.length)
    throw new Error(`Refusing to boot, the database role is not least-privilege: ${v.join('; ')}`);
}

/**
 * D-34 (1): in production the app process must not hold owner or superuser material. Pure over
 * `source` so it can be tested; `pnpm dev` (NODE_ENV=development) is unaffected by design.
 */
export function assertNoForbiddenEnv(source: NodeJS.ProcessEnv = process.env): void {
  if (source.NODE_ENV !== 'production') return;
  const leaked = forbiddenEnvPresent(source);
  if (leaked.length)
    throw new Error(`Refusing to boot, forbidden variables set: ${leaked.join(', ')}`);
}
