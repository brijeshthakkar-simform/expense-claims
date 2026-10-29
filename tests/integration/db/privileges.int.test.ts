// TC-I07 (03 §8.2–8.3, D-34/D-35): what expense_app can and cannot do, ported from the SQL
// proof's H1–H8 and G1–G3. P0 tables plus the P3 workflow migration's approval_policy_tiers,
// claim_submissions, approval_steps and claim_events; P6 adds receipts.
import { describe, expect, it } from 'vitest';
import { appClient, appSql, ownerSql, rejects } from '../../helpers/db';
import { makeDraft, submitAs } from '../../helpers/factories';

// a = INSERT, r = SELECT, w = UPDATE, d = DELETE (in that order). Every relation in public must be
// listed: a new table can't ship without deciding its grants (RT-m8).
const EXPECTED_DML: Record<string, string> = {
  departments: 'r',
  users: 'r',
  categories: 'r',
  sessions: 'arwd',
  claims: 'arwd',
  line_items: 'arwd',
  v_claim_total_drift: 'r',
  // P3 (workflow): the policy is read-only; submissions and events are INSERT-only (append-only);
  // steps are never deleted
  approval_policy_tiers: 'r',
  claim_submissions: 'ar',
  approval_steps: 'arw',
  claim_events: 'ar',
  // P6 (receipts): evidence is never updated in place; a replacement is a DELETE + INSERT (D-31)
  receipts: 'ard',
  _prisma_migrations: '',
};

const nonInternalTriggers = () =>
  ownerSql<{ relname: string; tgname: string }>`
    SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`;

describe('TC-I07 privileges', () => {
  it('privilege matrix for expense_app matches the expected matrix for every table in public', async () => {
    const relations = await ownerSql<{ relname: string; dml: string; ddl_like: boolean }>`
      SELECT c.relname,
             concat_ws('',
               CASE WHEN has_table_privilege('expense_app', c.oid, 'INSERT') THEN 'a' END,
               CASE WHEN has_table_privilege('expense_app', c.oid, 'SELECT') THEN 'r' END,
               CASE WHEN has_table_privilege('expense_app', c.oid, 'UPDATE') THEN 'w' END,
               CASE WHEN has_table_privilege('expense_app', c.oid, 'DELETE') THEN 'd' END) AS dml,
             has_table_privilege('expense_app', c.oid, 'TRUNCATE')
               OR has_table_privilege('expense_app', c.oid, 'TRIGGER')
               OR has_table_privilege('expense_app', c.oid, 'REFERENCES')
               OR has_table_privilege('expense_app', c.oid, 'MAINTAIN') AS ddl_like
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY c.relname`;

    expect(Object.fromEntries(relations.map((r) => [r.relname, r.dml]))).toEqual(EXPECTED_DML);
    expect(
      relations.filter((r) => r.ddl_like).map((r) => r.relname),
      'TRUNCATE / TRIGGER / REFERENCES / MAINTAIN on anything',
    ).toEqual([]);

    const sequences = await ownerSql`
      SELECT c.relname,
             has_sequence_privilege('expense_app', c.oid, 'USAGE') AS usage,
             has_sequence_privilege('expense_app', c.oid, 'SELECT') AS select,
             has_sequence_privilege('expense_app', c.oid, 'UPDATE') AS update
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'`;
    expect(sequences, 'nextval through the column default, but no setval').toEqual([
      { relname: 'claim_number_seq', usage: true, select: true, update: false },
    ]);

    await rejects('42501', () => appSql`SELECT * FROM _prisma_migrations`);
  });

  it('expense_app cannot DISABLE TRIGGER, TRUNCATE, or SET session_replication_role (42501)', async () => {
    const app = await appClient();
    await rejects('42501', () => app.query('SET session_replication_role = replica'));

    const triggers = await nonInternalTriggers();
    expect(triggers.length).toBeGreaterThan(0);
    for (const table of new Set(triggers.map((t) => t.relname)))
      for (const which of ['ALL', 'USER'])
        await rejects('42501', () => app.query(`ALTER TABLE ${table} DISABLE TRIGGER ${which}`));
    for (const { relname, tgname } of triggers)
      await rejects('42501', () => app.query(`ALTER TABLE ${relname} DISABLE TRIGGER ${tgname}`));

    // TRUNCATE fires no row triggers, so the app holds it on no table at all.
    const tables = await ownerSql<{ relname: string }>`
      SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname`;
    for (const { relname } of tables)
      await rejects('42501', () => app.query(`TRUNCATE ${relname} CASCADE`));
  });

  it('expense_app cannot UPDATE or DELETE claim_events or claim_submissions', async () => {
    const c = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 2_500_000 }] }),
    );
    const rows = () => ownerSql`
      SELECT (SELECT json_agg(s ORDER BY s.id) FROM claim_submissions s WHERE s.claim_id = ${c.id}) AS subs,
             (SELECT json_agg(e ORDER BY e.id) FROM claim_events e WHERE e.claim_id = ${c.id}) AS events,
             (SELECT json_agg(st ORDER BY st.id) FROM approval_steps st WHERE st.claim_id = ${c.id}) AS steps`;
    const before = await rows();

    // No grant (proof G1, G2): rewriting history or erasing it is a privilege error
    await rejects(
      '42501',
      () => appSql`UPDATE claim_events SET reason = 'x' WHERE claim_id = ${c.id}`,
    );
    await rejects('42501', () => appSql`UPDATE claim_events SET request_id = 'forged-request-id'`);
    await rejects('42501', () => appSql`DELETE FROM claim_events WHERE claim_id = ${c.id}`);
    await rejects(
      '42501',
      () => appSql`UPDATE claim_submissions SET total_minor = 1 WHERE claim_id = ${c.id}`,
    );
    await rejects('42501', () => appSql`UPDATE claim_submissions SET snapshot = '{}'::jsonb`);
    await rejects('42501', () => appSql`DELETE FROM claim_submissions WHERE claim_id = ${c.id}`);
    // Steps may change status (decisions), but never disappear (proof G3)
    await rejects('42501', () => appSql`DELETE FROM approval_steps WHERE claim_id = ${c.id}`);
    // The owner holds the grants, and still hits the append-only triggers (UC007)
    await rejects(
      'UC007',
      () => ownerSql`UPDATE claim_events SET reason = 'x' WHERE claim_id = ${c.id}`,
    );
    await rejects('UC007', () => ownerSql`DELETE FROM claim_events WHERE claim_id = ${c.id}`);
    await rejects(
      'UC007',
      () => ownerSql`UPDATE claim_submissions SET total_minor = 1 WHERE claim_id = ${c.id}`,
    );
    await rejects('UC007', () => ownerSql`DELETE FROM claim_submissions WHERE claim_id = ${c.id}`);
    await rejects('UC007', () => ownerSql`DELETE FROM approval_steps WHERE claim_id = ${c.id}`);

    expect(await rows()).toEqual(before);
  });

  it('expense_app cannot write users, departments, categories or approval_policy_tiers', async () => {
    const asha = `asha.rao@acme.test`;
    // Self-promotion to FINANCE, re-pointing a manager, minting or removing people (RT-M7).
    await rejects('42501', () => appSql`UPDATE users SET role = 'FINANCE' WHERE email = ${asha}`);
    await rejects(
      '42501',
      () => appSql`
        UPDATE users SET manager_id = (SELECT id FROM users WHERE email = 'neha.kapoor@acme.test')
         WHERE email = ${asha}`,
    );
    await rejects(
      '42501',
      () => appSql`
        INSERT INTO users (employee_code, email, name, department_id)
        VALUES ('T0000001', 'tmp.attack@acme.test', 'Mallory', (SELECT id FROM departments LIMIT 1))`,
    );
    await rejects('42501', () => appSql`DELETE FROM users WHERE email = ${asha}`);
    await rejects('42501', () => appSql`INSERT INTO departments (code, name) VALUES ('X', 'X')`);
    await rejects('42501', () => appSql`UPDATE departments SET name = 'Renamed'`);
    await rejects('42501', () => appSql`DELETE FROM departments`);
    await rejects(
      '42501',
      () => appSql`INSERT INTO categories (code, name, gl_code) VALUES ('X', 'X', '1234')`,
    );
    await rejects('42501', () => appSql`UPDATE categories SET is_active = true`);
    await rejects('42501', () => appSql`DELETE FROM categories`);
    // Collapsing the approval policy (P3): fewer tiers, lower bars, a tier routed to oneself
    await rejects(
      '42501',
      () => appSql`UPDATE approval_policy_tiers SET is_active = false WHERE level > 1`,
    );
    await rejects(
      '42501',
      () => appSql`UPDATE approval_policy_tiers SET applies_above_minor = 999999999`,
    );
    await rejects(
      '42501',
      () => appSql`
        UPDATE approval_policy_tiers SET resolver = 'DESIGNATED_USER', levels_up = NULL,
               designated_user_id = (SELECT id FROM users WHERE email = ${asha})`,
    );
    await rejects('42501', () => appSql`DELETE FROM approval_policy_tiers`);
    await rejects(
      '42501',
      () => appSql`
        INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver, levels_up)
        VALUES (9, 'X', 'X', 1, 'REPORTING_LINE', 1)`,
    );

    // Nor by borrowing someone else's rights (proof H5).
    const app = await appClient();
    await rejects('42501', () => app.query('SET ROLE expense_owner'));
    await rejects('42501', () => app.query('SET ROLE postgres'));
    await rejects('42501', () => app.query('ALTER ROLE expense_app SUPERUSER'));
    await rejects('42501', () => app.query('ALTER ROLE expense_app BYPASSRLS'));
    await app.query('GRANT UPDATE ON users TO expense_app').catch(() => {}); // grants nothing
    const [granted] = await ownerSql`
      SELECT has_table_privilege('expense_app', 'users', 'UPDATE') AS update_users`;
    expect(granted).toEqual({ update_users: false });

    const [user] = await ownerSql`SELECT role, manager_id IS NOT NULL AS has_manager
                                    FROM users WHERE email = ${asha}`;
    expect(user).toEqual({ role: 'EMPLOYEE', has_manager: true });
  });

  it('expense_app has no TEMP or CREATE privilege', async () => {
    const [privileges] = await ownerSql`
      SELECT has_database_privilege('expense_app', current_database(), 'TEMPORARY') AS temp,
             has_database_privilege('expense_app', current_database(), 'CREATE') AS create_in_db,
             has_schema_privilege('expense_app', 'public', 'CREATE') AS create_in_public`;
    expect(privileges).toEqual({ temp: false, create_in_db: false, create_in_public: false });

    const app = await appClient();
    // A temp table named line_items would shadow public.line_items for unqualified names (RT-M10).
    await rejects('42501', () =>
      app.query('CREATE TEMP TABLE line_items (claim_id uuid, amount_minor int)'),
    );
    await rejects('42501', () => app.query('CREATE TABLE public.evil (id int)'));
    await rejects('42501', () =>
      app.query(`CREATE FUNCTION public.evil() RETURNS int LANGUAGE sql AS 'SELECT 1'`),
    );
    await rejects('42501', () => app.query('CREATE VIEW public.evil_v AS SELECT 1'));
    await rejects('42501', () => app.query('CREATE SCHEMA evil'));
    await rejects('42501', () => app.query('CREATE DATABASE evil'));

    // The role attributes behind it, as 01-roles.sh sets them (proof H8).
    const [role] = await ownerSql`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit,
             rolconfig::text[] AS config,
             pg_has_role('expense_app', 'expense_owner', 'MEMBER') AS member_of_owner,
             EXISTS (SELECT 1 FROM pg_class c
                      WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owns
        FROM pg_roles r WHERE rolname = 'expense_app'`;
    expect(role).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolinherit: false,
      config: expect.arrayContaining([
        'statement_timeout=15s',
        'lock_timeout=5s',
        'idle_in_transaction_session_timeout=30s',
      ]),
      member_of_owner: false,
      owns: false,
    });
  });
});
