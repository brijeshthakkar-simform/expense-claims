// Reference data and the C-15 demo cast (03 §12, D-45). Shared by prisma/seed.ts (the `release`
// step, as expense_owner) and the integration harness (tests/helpers/global-setup.ts, db.ts), so
// tests and the demo run on the same rows. Plain SQL as the owner: expense_app can't write users,
// departments or categories (C-16).
import pg from 'pg';
import { hashPassword } from '@/server/auth/password';
import type { PolicyTier } from '@/server/routing/build-chain';
import { assertPolicyWellFormed } from '@/server/routing/policy';

/** A tagged-template query: values become $1..$n parameters, never interpolated into the text. */
export type SeedSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

export const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'FIN', name: 'Finance' },
  { code: 'EXEC', name: 'Executive' },
] as const;

/** 10 active categories and the retired LEGACY_PER_DIEM (the UC013 / CATEGORY_INACTIVE demo). */
export const CATEGORIES = [
  { code: 'TRAVEL_AIR', name: 'Air travel', glCode: '6101', isActive: true },
  { code: 'TRAVEL_RAIL', name: 'Rail travel', glCode: '6102', isActive: true },
  { code: 'LOCAL_TRANSPORT', name: 'Local transport', glCode: '6103', isActive: true },
  { code: 'LODGING', name: 'Hotels & lodging', glCode: '6110', isActive: true },
  { code: 'MEALS', name: 'Meals', glCode: '6120', isActive: true },
  { code: 'CLIENT_ENTERTAINMENT', name: 'Client entertainment', glCode: '6130', isActive: true },
  { code: 'OFFICE_SUPPLIES', name: 'Office supplies', glCode: '6200', isActive: true },
  { code: 'INTERNET_PHONE', name: 'Internet & phone', glCode: '6210', isActive: true },
  { code: 'TRAINING', name: 'Training & courses', glCode: '6300', isActive: true },
  { code: 'MISC', name: 'Miscellaneous', glCode: '6900', isActive: true },
  { code: 'LEGACY_PER_DIEM', name: 'Per diem (retired)', glCode: '6199', isActive: false },
] as const;

/** The L4 tier's designated user (C-13): the CFO, also the fallback approver. */
export const L4_DESIGNATED_EMAIL = 'deepa.menon@acme.test';

/**
 * C-13 approval tiers, thresholds as exclusive lower bounds in paise. L4_CFO is seeded INACTIVE
 * (`pnpm policy:activate-tier L4_CFO` is the §8 demo) and only once its designated user exists.
 */
export const TIERS = [
  { level: 1, code: 'L1_MANAGER', label: 'Line manager', appliesAboveMinor: 0, levelsUp: 1 },
  {
    level: 2,
    code: 'L2_SKIP_LEVEL',
    label: 'Skip-level manager',
    appliesAboveMinor: 1_000_000,
    levelsUp: 2,
  },
  {
    level: 3,
    code: 'L3_SENIOR_LEADER',
    label: 'Senior leader',
    appliesAboveMinor: 5_000_000,
    levelsUp: 3,
  },
] as const;
export const L4_TIER = {
  level: 4,
  code: 'L4_CFO',
  label: 'CFO',
  appliesAboveMinor: 20_000_000,
} as const;

/** The seeded policy as PolicyTier rows (`l4UserId` null = L4 not seeded yet). */
export function seededPolicy(l4UserId: string | null): PolicyTier[] {
  const tiers: PolicyTier[] = TIERS.map((t) => ({
    ...t,
    resolver: 'REPORTING_LINE',
    designatedUserId: null,
    isActive: true,
  }));
  if (l4UserId)
    tiers.push({
      ...L4_TIER,
      resolver: 'DESIGNATED_USER',
      levelsUp: null,
      designatedUserId: l4UserId,
      isActive: false,
    });
  return tiers;
}

export interface CastMember {
  email: string;
  name: string;
  employeeCode: string;
  department: (typeof DEPARTMENTS)[number]['code'];
  role: 'EMPLOYEE' | 'FINANCE' | 'ADMIN';
  canApprove: boolean;
  isFallbackApprover: boolean;
  managerEmail: string | null;
}

const member = (
  local: string,
  name: string,
  employeeCode: string,
  department: CastMember['department'],
  role: CastMember['role'],
  canApprove: boolean,
  isFallbackApprover: boolean,
  manager: string | null,
): CastMember => ({
  email: `${local}@acme.test`,
  name,
  employeeCode,
  department,
  role,
  canApprove,
  isFallbackApprover,
  managerEmail: manager && `${manager}@acme.test`,
});

/** C-15, managers before their reports so manager_id resolves on insert. */
export const CAST: readonly CastMember[] = [
  member('vikram.shah', 'Vikram Shah', 'E1004', 'EXEC', 'EMPLOYEE', true, false, null),
  member('admin', 'Site Admin', 'E1009', 'EXEC', 'ADMIN', false, false, null),
  member('meera.iyer', 'Meera Iyer', 'E1003', 'ENG', 'EMPLOYEE', true, false, 'vikram.shah'),
  member('deepa.menon', 'Deepa Menon', 'E1005', 'FIN', 'EMPLOYEE', true, true, 'vikram.shah'),
  member('ravi.menon', 'Ravi Menon', 'E1002', 'ENG', 'EMPLOYEE', true, false, 'meera.iyer'),
  member('neha.kapoor', 'Neha Kapoor', 'E1006', 'ENG', 'EMPLOYEE', true, false, 'meera.iyer'),
  member('asha.rao', 'Asha Rao', 'E1001', 'ENG', 'EMPLOYEE', false, false, 'ravi.menon'),
  member('arjun.das', 'Arjun Das', 'E1007', 'ENG', 'EMPLOYEE', false, false, 'neha.kapoor'),
  member('farah.khan', 'Farah Khan', 'E1008', 'FIN', 'FINANCE', false, false, 'deepa.menon'),
];

const DEMO_FORBIDDEN_ENVS = new Set(['staging', 'production']);

// ------------------------------------------------------------------------------- reference data

/**
 * Part 1 of the seed: runs on every `release`, in every environment. Idempotent (`ON CONFLICT
 * (code) DO NOTHING`), so it never overwrites a row an operator changed and brings new reference
 * rows to an existing volume: departments, categories, tiers L1–L3 (and L4_CFO, inactive, once
 * deepa exists).
 */
export async function seedReference(sql: SeedSql): Promise<void> {
  await sql`
    INSERT INTO departments (code, name)
    SELECT * FROM unnest(${DEPARTMENTS.map((d) => d.code)}::text[],
                         ${DEPARTMENTS.map((d) => d.name)}::text[])
    ON CONFLICT (code) DO NOTHING`;
  await sql`
    INSERT INTO categories (code, name, gl_code, is_active, sort_order)
    SELECT code, name, gl_code, is_active, ord::smallint
      FROM unnest(${CATEGORIES.map((c) => c.code)}::text[],
                  ${CATEGORIES.map((c) => c.name)}::text[],
                  ${CATEGORIES.map((c) => c.glCode)}::text[],
                  ${CATEGORIES.map((c) => c.isActive)}::boolean[])
           WITH ORDINALITY AS v(code, name, gl_code, is_active, ord)
    ON CONFLICT (code) DO NOTHING`;
  await seedTiers(sql);
}

/**
 * Tiers L1–L3 (active) and, once deepa exists, L4_CFO (inactive). ON CONFLICT (code) DO NOTHING,
 * so an activated L4 is never reset by a later release. The stored policy is then re-read and
 * checked: a malformed policy fails the release instead of the app's boot.
 */
async function seedTiers(sql: SeedSql): Promise<void> {
  assertPolicyWellFormed(seededPolicy(null)); // the constants themselves, before any write
  await sql`
    INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver, levels_up)
    SELECT level, code, label, applies_above_minor, 'REPORTING_LINE', levels_up
      FROM unnest(${TIERS.map((t) => t.level)}::smallint[], ${TIERS.map((t) => t.code)}::text[],
                  ${TIERS.map((t) => t.label)}::text[],
                  ${TIERS.map((t) => t.appliesAboveMinor)}::integer[],
                  ${TIERS.map((t) => t.levelsUp)}::smallint[])
           AS v(level, code, label, applies_above_minor, levels_up)
    ON CONFLICT (code) DO NOTHING`;
  await sql`
    INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver,
                                       designated_user_id, is_active)
    SELECT ${L4_TIER.level}, ${L4_TIER.code}, ${L4_TIER.label}, ${L4_TIER.appliesAboveMinor},
           'DESIGNATED_USER', u.id, false
      FROM users u WHERE u.email = ${L4_DESIGNATED_EMAIL}
    ON CONFLICT (code) DO NOTHING`;
  assertPolicyWellFormed(await readTiers(sql));
}

/** Every stored tier as PolicyTier rows (owner SQL). */
export async function readTiers(sql: SeedSql): Promise<PolicyTier[]> {
  return (await sql`
    SELECT level, code, label, applies_above_minor AS "appliesAboveMinor", resolver::text AS resolver,
           levels_up AS "levelsUp", designated_user_id AS "designatedUserId", is_active AS "isActive"
      FROM approval_policy_tiers ORDER BY level`) as unknown as PolicyTier[];
}

// ------------------------------------------------------------------------------------- the cast

/** Refuses outside local/test and refuses any non-`.test` address (RT-m7, 04 §11). */
export function assertCastAllowed(appEnv: string | undefined, cast = CAST): void {
  if (appEnv && DEMO_FORBIDDEN_ENVS.has(appEnv))
    throw new Error(`Refusing to seed the demo cast with APP_ENV=${appEnv}`);
  const bad = cast.filter((m) => !m.email.endsWith('.test'));
  if (bad.length)
    throw new Error(`Refusing to seed non-.test emails: ${bad.map((m) => m.email).join(', ')}`);
}

/**
 * Part 2: the nine-person cast, each with its own argon2id hash of `password`. Idempotent
 * (`ON CONFLICT (email) DO NOTHING`); seed.ts calls it only when SEED_ON_START=true and `users` is
 * empty. Returns the number of users inserted.
 */
export async function seedCast(
  sql: SeedSql,
  opts: { password: string; appEnv?: string | undefined },
): Promise<number> {
  assertCastAllowed(opts.appEnv);
  if (opts.password.length < 8) throw new Error('The demo password must be at least 8 characters');
  const hashes = await Promise.all(CAST.map(() => hashPassword(opts.password)));
  let inserted = 0;
  for (const [i, m] of CAST.entries()) {
    const rows = await sql`
      INSERT INTO users (employee_code, email, name, role, can_approve, is_fallback_approver,
                         department_id, manager_id, password_hash)
      VALUES (${m.employeeCode}, ${m.email}, ${m.name}, ${m.role}::user_role, ${m.canApprove},
              ${m.isFallbackApprover}, (SELECT id FROM departments WHERE code = ${m.department}),
              (SELECT id FROM users WHERE email = ${m.managerEmail}), ${hashes[i]})
      ON CONFLICT (email) DO NOTHING
      RETURNING id`;
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Puts the reference rows and the cast's flags back to their seeded values, for the integration
 * harness's per-test reset: categories' is_active; the cast's role, can_approve,
 * is_fallback_approver, is_active, department and manager; the tiers (unknown codes deleted, the
 * seeded ones back to their C-13 values, L4_CFO inactive). Passwords are left alone. Only rows that
 * differ are written.
 */
export async function restoreReference(sql: SeedSql): Promise<void> {
  const known = [...TIERS.map((t) => t.code), L4_TIER.code];
  // First, so the seed's own well-formedness check below sees a policy it can extend.
  await sql`DELETE FROM approval_policy_tiers WHERE code <> ALL(${known}::text[])`;
  await sql`
    UPDATE approval_policy_tiers t
       SET level = v.level, label = v.label, applies_above_minor = v.applies_above_minor,
           resolver = v.resolver::approver_resolver, levels_up = v.levels_up,
           designated_user_id = u.id, is_active = v.is_active
      FROM unnest(${known}::text[],
                  ${[...TIERS.map((t) => t.level), L4_TIER.level]}::smallint[],
                  ${[...TIERS.map((t) => t.label), L4_TIER.label]}::text[],
                  ${[...TIERS.map((t) => t.appliesAboveMinor), L4_TIER.appliesAboveMinor]}::integer[],
                  ${[...TIERS.map(() => 'REPORTING_LINE'), 'DESIGNATED_USER']}::text[],
                  ${[...TIERS.map((t) => t.levelsUp), null]}::smallint[],
                  ${[...TIERS.map(() => null), L4_DESIGNATED_EMAIL]}::text[],
                  ${[...TIERS.map(() => true), false]}::boolean[])
           AS v(code, level, label, applies_above_minor, resolver, levels_up, designated_email,
                is_active)
      LEFT JOIN users u ON u.email = v.designated_email
     WHERE t.code = v.code
       AND (t.level, t.label, t.applies_above_minor, t.resolver::text, t.levels_up,
            t.designated_user_id, t.is_active)
           IS DISTINCT FROM (v.level, v.label, v.applies_above_minor, v.resolver, v.levels_up, u.id,
                             v.is_active)`;
  await seedReference(sql);
  await sql`
    UPDATE categories c SET is_active = v.is_active
      FROM unnest(${CATEGORIES.map((x) => x.code)}::text[],
                  ${CATEGORIES.map((x) => x.isActive)}::boolean[]) AS v(code, is_active)
     WHERE c.code = v.code AND c.is_active IS DISTINCT FROM v.is_active`;
  await sql`
    UPDATE users u
       SET role = v.role::user_role, can_approve = v.can_approve,
           is_fallback_approver = v.is_fallback_approver, is_active = true,
           department_id = d.id, manager_id = m.id
      FROM unnest(${CAST.map((x) => x.email)}::text[], ${CAST.map((x) => x.role)}::text[],
                  ${CAST.map((x) => x.canApprove)}::boolean[],
                  ${CAST.map((x) => x.isFallbackApprover)}::boolean[],
                  ${CAST.map((x) => x.department)}::text[],
                  ${CAST.map((x) => x.managerEmail)}::text[])
           AS v(email, role, can_approve, is_fallback_approver, department, manager_email)
      JOIN departments d ON d.code = v.department
      LEFT JOIN users m ON m.email = v.manager_email
     WHERE u.email = v.email
       AND (u.role::text, u.can_approve, u.is_fallback_approver, u.is_active, u.department_id,
            u.manager_id)
           IS DISTINCT FROM (v.role, v.can_approve, v.is_fallback_approver, true, d.id, m.id)`;
}

// ------------------------------------------------------------------------------------- helpers

/** Tagged-template wrapper over one pg connection (the same shape as tests/helpers/db.ts `Sql`). */
export const sqlOf =
  (client: pg.Client): SeedSql =>
  async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => `${acc}$${i}${part}`);
    return (await client.query<Record<string, unknown>>(text, values)).rows;
  };

/** Runs `fn` in one transaction on a fresh connection to `url`. */
export async function withOwnerTx<T>(url: string, fn: (sql: SeedSql) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'expense-seed' });
  await client.connect();
  const sql = sqlOf(client);
  try {
    await sql`BEGIN`;
    const result = await fn(sql);
    await sql`COMMIT`;
    return result;
  } catch (err) {
    await sql`ROLLBACK`.catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * For the integration harness: reference data plus the cast with a known password, in one
 * transaction as the owner. The same idempotent inserts the `release` seed uses.
 */
export async function seedReferenceAndCast(url: string, opts: { password: string }): Promise<void> {
  await withOwnerTx(url, async (sql) => {
    await seedReference(sql);
    await seedCast(sql, { password: opts.password, appEnv: process.env.APP_ENV });
    await seedReference(sql); // again: L4_CFO needs its designated user (deepa) to exist
  });
}
