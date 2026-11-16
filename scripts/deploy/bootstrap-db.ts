// Hosted database bootstrap (docs/deploy-vercel-free.md). Run by scripts/deploy/hosted-setup.sh with
// `pnpm exec tsx scripts/deploy/bootstrap-db.ts`; it is the hosted twin of
// docker/postgres/initdb/01-roles.sh, for a provider that gives you an admin role but no superuser
// (Neon: neondb_owner has CREATEROLE and CREATEDB). Reads ONLY these variables, never the repo .env,
// so a mistake can never fall back to the local compose database:
//   ADMIN_DATABASE_URL  direct (not pooled) URL of the admin role, in the database to set up
//   OWNER_PASSWORD      password to give expense_owner (migrations and seed)
//   APP_PASSWORD        password to give expense_app (the runtime role)
// Idempotent: a missing role is created, an existing one only gets the new password. Nothing is
// ever dropped. Needs PostgreSQL 18 (uuidv7() is native there). Prints host and database name only.
import pg from 'pg';

const OWNER = 'expense_owner';
const APP = 'expense_app';
const log = (msg: string) => console.log(`[bootstrap-db] ${msg}`);

function fail(msg: string): never {
  console.error(`[bootstrap-db] ${msg}`);
  process.exit(1);
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) fail(`${name} is required (run scripts/deploy/hosted-setup.sh, which sets it)`);
  return value;
};

const adminUrl = required('ADMIN_DATABASE_URL');
const ownerPassword = required('OWNER_PASSWORD');
const appPassword = required('APP_PASSWORD');

/** The same server and database as the admin URL, as another role. Never logged. */
function urlAs(role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

async function connect(url: string, who: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
  } catch (err) {
    // pg's message names the role or the server, never the password.
    fail(`cannot connect as ${who}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return client;
}

const lit = (s: string) => pg.escapeLiteral(s);
const ident = (s: string) => pg.escapeIdentifier(s);

async function one<T extends pg.QueryResultRow>(
  c: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const row = (await c.query<T>(text, values)).rows[0];
  if (!row) fail(`query returned no row: ${text.replace(/\s+/g, ' ').trim()}`);
  return row;
}

const roleExists = async (c: pg.Client, name: string) =>
  (await c.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [name])).rowCount === 1;

async function ensureRole(c: pg.Client, name: string, password: string, attrs: string) {
  if (await roleExists(c, name)) {
    // Attributes are checked at the end, not rewritten: a role made elsewhere must be dropped by hand.
    await c.query(`ALTER ROLE ${ident(name)} WITH PASSWORD ${lit(password)}`);
    log(`role ${name} exists: password updated`);
  } else {
    await c.query(`CREATE ROLE ${ident(name)} LOGIN PASSWORD ${lit(password)} ${attrs}`);
    log(`role ${name} created`);
  }
}

async function main(): Promise<void> {
  const target = new URL(adminUrl);
  const db = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!db) fail('ADMIN_DATABASE_URL has no database name');
  log(`target: host ${target.hostname}, database ${db}`);

  const admin = await connect(adminUrl, 'the admin role');
  try {
    const info = await one<{ me: string; db: string; num: number; csr: boolean; cdb: boolean }>(
      admin,
      `SELECT current_user::text AS me, current_database()::text AS db,
              current_setting('server_version_num')::int AS num,
              (r.rolsuper OR r.rolcreaterole) AS csr, (r.rolsuper OR r.rolcreatedb) AS cdb
         FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
    );
    if (info.num < 180000)
      fail(
        `PostgreSQL ${Math.floor(info.num / 10000)} found; this app needs 18 (migrations default ids to the ` +
          'built-in uuidv7()). Create the database on PostgreSQL 18 and start again.',
      );
    if (!info.csr || !info.cdb)
      fail(
        `the admin role ${info.me} needs CREATEROLE and CREATEDB (or SUPERUSER) to set up roles`,
      );
    if (info.me === OWNER || info.me === APP)
      fail(`ADMIN_DATABASE_URL is already the ${info.me} role; use the provider's admin role`);
    if (info.db !== db) fail(`connected to ${info.db}, expected ${db}`);
    const me = info.me;
    log(`server version number ${info.num}, admin role ${me}`);

    // 1. Roles. CREATE ROLE cannot take bind parameters, hence escapeLiteral for the passwords.
    await ensureRole(
      admin,
      OWNER,
      ownerPassword,
      'NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS',
    );
    await ensureRole(
      admin,
      APP,
      appPassword,
      'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT',
    );
    await admin.query(`ALTER ROLE ${APP} SET statement_timeout = '15s'`);
    await admin.query(`ALTER ROLE ${APP} SET lock_timeout = '5s'`);
    await admin.query(`ALTER ROLE ${APP} SET idle_in_transaction_session_timeout = '30s'`);

    // 2. Let the admin SET ROLE to the owner (PG 16+ syntax; a repeat is a no-op or a notice), then
    //    hand the database and the public schema over. Ownership is checked first because once the
    //    owner has them the admin, who only holds SET, may no longer alter them.
    try {
      await admin.query(`GRANT ${OWNER} TO CURRENT_USER WITH SET TRUE`);
    } catch (err) {
      if (!(err instanceof Error) || !/already/i.test(err.message)) throw err;
    }
    const owners = await one<{ db_owner: string; schema_owner: string }>(
      admin,
      `SELECT pg_catalog.pg_get_userbyid(d.datdba)::text AS db_owner,
              pg_catalog.pg_get_userbyid(n.nspowner)::text AS schema_owner
         FROM pg_catalog.pg_database d, pg_catalog.pg_namespace n
        WHERE d.datname = current_database() AND n.nspname = 'public'`,
    );
    // While the admin still owns the database it also owns public, even when public belongs to
    // pg_database_owner, so moving the schema first works on every provider.
    let schemaMoved = owners.schema_owner === OWNER;
    if (!schemaMoved) {
      try {
        await admin.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
        schemaMoved = true;
      } catch {
        log('the admin cannot move schema public yet; the new database owner will');
      }
    }
    if (owners.db_owner !== OWNER) {
      try {
        await admin.query(`ALTER DATABASE ${ident(db)} OWNER TO ${OWNER}`);
      } catch (err) {
        fail(
          `cannot make ${OWNER} the owner of ${db}: ${err instanceof Error ? err.message : String(err)}\n` +
            `  Create a database owned by ${OWNER} in the provider's dashboard (this run already created the role),\n` +
            '  put its name in the admin connection string and run the script again.',
        );
      }
      log(`database ${db} now owned by ${OWNER}`);
    } else {
      log(`database ${db} is already owned by ${OWNER}`);
    }

    // 3. The rest as the owner, mirroring docker/postgres/initdb/01-roles.sh. The revoke below also
    //    drops the admin's own CONNECT, which would lock it out of this database, so grant it back.
    await admin.query(`SET ROLE ${OWNER}`);
    if (!schemaMoved) await admin.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
    await admin.query(`ALTER DATABASE ${ident(db)} SET timezone TO 'UTC'`);
    await admin.query(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${APP}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(me)}`);
    await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP}`);
    await admin.query('RESET ROLE');
    log('owner, schema, timezone and grants applied');

    await verify(admin, db, me);
  } finally {
    await admin.end().catch(() => {});
  }
}

/** Reads the result back from the catalogs and from real logins; exits 1 listing everything wrong. */
async function verify(admin: pg.Client, db: string, me: string): Promise<void> {
  const bad: string[] = [];

  const attrs = (
    await admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
      rolreplication: boolean;
      rolconfig: string[] | null;
    }>(
      `SELECT rolname::text, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
              rolreplication, rolconfig
         FROM pg_catalog.pg_roles WHERE rolname IN ($1, $2)`,
      [OWNER, APP],
    )
  ).rows;
  for (const name of [OWNER, APP]) {
    const r = attrs.find((a) => a.rolname === name);
    if (!r) {
      bad.push(`role ${name} is missing`);
      continue;
    }
    const on = [
      ['SUPERUSER', r.rolsuper],
      ['CREATEROLE', r.rolcreaterole],
      ['CREATEDB', r.rolcreatedb],
      ['BYPASSRLS', r.rolbypassrls],
      ['REPLICATION', r.rolreplication],
    ].filter(([, v]) => v);
    if (on.length)
      bad.push(
        `${name} has ${on.map(([k]) => k).join(', ')}; drop the role in the provider and run again`,
      );
    if (!r.rolcanlogin) bad.push(`${name} cannot log in`);
  }
  const config = attrs.find((a) => a.rolname === APP)?.rolconfig ?? [];
  for (const setting of [
    'statement_timeout=15s',
    'lock_timeout=5s',
    'idle_in_transaction_session_timeout=30s',
  ])
    if (!config.includes(setting)) bad.push(`${APP} is missing the setting ${setting}`);

  const own = await one<{ db_owner: string; schema_owner: string; tz: boolean }>(
    admin,
    `SELECT pg_catalog.pg_get_userbyid(d.datdba)::text AS db_owner,
            pg_catalog.pg_get_userbyid(n.nspowner)::text AS schema_owner,
            EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
                     WHERE s.setdatabase = d.oid AND s.setrole = 0
                       AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c
                                    WHERE lower(c) = 'timezone=utc')) AS tz
       FROM pg_catalog.pg_database d, pg_catalog.pg_namespace n
      WHERE d.datname = current_database() AND n.nspname = 'public'`,
  );
  if (own.db_owner !== OWNER) bad.push(`database owner is ${own.db_owner}, not ${OWNER}`);
  if (own.schema_owner !== OWNER)
    bad.push(`schema public owner is ${own.schema_owner}, not ${OWNER}`);
  if (!own.tz) bad.push('the database setting timezone=UTC is missing');

  // No grant to PUBLIC may remain (a NULL ACL means the defaults, which include PUBLIC).
  const pub = await one<{ db_open: boolean; schema_open: boolean }>(
    admin,
    `SELECT (d.datacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(d.datacl) a WHERE a.grantee = 0))
              AS db_open,
            (n.nspacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee = 0))
              AS schema_open
       FROM pg_catalog.pg_database d, pg_catalog.pg_namespace n
      WHERE d.datname = current_database() AND n.nspname = 'public'`,
  );
  if (pub.db_open) bad.push('PUBLIC still has privileges on the database');
  if (pub.schema_open) bad.push('PUBLIC still has privileges on schema public');
  const appPriv = await one<{ connect: boolean; usage: boolean }>(
    admin,
    `SELECT pg_catalog.has_database_privilege($1, current_database(), 'CONNECT') AS connect,
            pg_catalog.has_schema_privilege($1, 'public', 'USAGE') AS usage`,
    [APP],
  );
  if (!appPriv.connect) bad.push(`${APP} cannot CONNECT to the database`);
  if (!appPriv.usage) bad.push(`${APP} has no USAGE on schema public`);

  // The runtime role must reach neither the owner nor anything that can switch the DB guards off.
  const memberships = (
    await admin.query<{ rolname: string; risky: boolean }>(
      `SELECT g.rolname::text,
              (g.rolname = $2 OR g.rolsuper OR g.rolcreaterole OR g.rolcreatedb OR g.rolbypassrls
                 OR g.rolreplication OR g.rolname ILIKE '%superuser%') AS risky
         FROM pg_catalog.pg_roles g
         JOIN pg_catalog.pg_roles m ON m.rolname = $1
        WHERE g.oid <> m.oid AND pg_catalog.pg_has_role(m.oid, g.oid, 'MEMBER')`,
      [APP, OWNER],
    )
  ).rows;
  for (const m of memberships) {
    if (m.risky) bad.push(`${APP} is a member of ${m.rolname}`);
    else log(`note: ${APP} is a member of ${m.rolname} (not privileged, left alone)`);
  }

  // Real logins: the new passwords work, and the admin was not locked out by the PUBLIC revoke.
  for (const [who, url] of [
    [OWNER, urlAs(OWNER, ownerPassword)],
    [APP, urlAs(APP, appPassword)],
    [me, adminUrl],
  ] as const) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    try {
      await c.connect();
      const row = await one<{ u: string; d: string }>(
        c,
        'SELECT current_user::text AS u, current_database()::text AS d',
      );
      if (row.u !== who || row.d !== db) bad.push(`login as ${who} reached ${row.u}@${row.d}`);
    } catch (err) {
      bad.push(`cannot log in as ${who}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await c.end().catch(() => {});
    }
  }

  if (bad.length) {
    for (const b of bad) console.error(`[bootstrap-db] CHECK FAILED: ${b}`);
    fail(`${bad.length} check(s) failed; the database is not ready`);
  }
  log(
    `OK: ${OWNER} and ${APP} are plain login roles (no SUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS)`,
  );
  log(`OK: ${OWNER} owns database ${db} and schema public; ${APP} is in no privileged role`);
  log(`OK: PUBLIC has nothing; ${APP} may CONNECT and USE public; timezone UTC; timeouts set`);
  log(`OK: logins work as ${OWNER}, ${APP} and the admin ${me}`);
}

await main().catch((err: unknown) => {
  fail(`failed: ${err instanceof Error ? err.message : String(err)}`);
});
