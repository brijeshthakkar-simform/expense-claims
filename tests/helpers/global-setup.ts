// Vitest globalSetup for the integration project (07 §3.1, D-42). Runs once per `vitest run`:
//   1. one PostgreSQL 18 database with production roles and REVOKEs (docker/postgres/initdb/01-roles.sh)
//   2. `prisma migrate deploy` as expense_owner
//   3. seedReferenceAndCast(): the same reference rows and C-15 cast the `release` seed writes, with
//      a random demo password for this run (CI has no .env and Vitest doesn't load one)
//   4. provide appUrl / ownerUrl / superUrl / demoPassword to the test workers
//
// Two ways to get the database:
//   - default: Testcontainers `postgres:18.6-trixie` with 01-roles.sh mounted as an initdb script.
//   - TEST_PG_SUPERUSER_URL (external mode, for machines without a Docker daemon): a superuser URL
//     for an already-running, disposable PostgreSQL 18 cluster, e.g.
//       TEST_PG_SUPERUSER_URL=postgres://postgres:pw@127.0.0.1:54417/postgres pnpm test:int
//     It creates a fresh `expense_claims_test_<hex>` database, runs the SAME SQL as 01-roles.sh
//     (parsed from the script, so there is one source of truth), and drops the database at teardown.
//     Roles are cluster-wide: existing expense_owner / expense_app roles get their attributes
//     re-asserted and fresh passwords, so it refuses a cluster that hosts a non-test database
//     owned by expense_owner (e.g. the compose database).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { seedReferenceAndCast } from '../../prisma/seed-personas';

declare module 'vitest' {
  export interface ProvidedContext {
    appUrl: string;
    ownerUrl: string;
    superUrl: string;
    /** The cast's login password for this run (TC-I02's successful-login cases). */
    demoPassword: string;
  }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROLES_SCRIPT = `${ROOT}docker/postgres/initdb/01-roles.sh`;
const PRISMA_BIN = `${ROOT}node_modules/.bin/prisma`;
const IMAGE =
  'postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336'; // same digest as compose.yaml
const TEST_DB_PREFIX = 'expense_claims_test_';

const secret = () => randomBytes(12).toString('hex'); // URL-safe, fresh every run
const { escapeIdentifier: quoteIdent, escapeLiteral: quoteLiteral } = pg;

type Database = {
  /** URL for `user` on the test database. */
  url(user: string, password: string): string;
  superUrl: string;
  name: string;
  stop(): Promise<void>;
};

export default async function setup(project: TestProject) {
  const ownerPw = secret();
  const appPw = secret();
  const demoPw = secret();
  const external = process.env.TEST_PG_SUPERUSER_URL;
  const db = external
    ? await createExternalDatabase(external, ownerPw, appPw)
    : await startContainer(ownerPw, appPw);
  try {
    const ownerUrl = db.url('expense_owner', ownerPw);
    migrateDeploy(ownerUrl);
    await seedReferenceAndCast(ownerUrl, { password: demoPw });

    project.provide('appUrl', db.url('expense_app', appPw));
    project.provide('ownerUrl', ownerUrl);
    project.provide('superUrl', db.superUrl); // monitor connection only (pg_stat_activity)
    project.provide('demoPassword', demoPw);
  } catch (err) {
    await db.stop().catch(() => {});
    throw err;
  }
  return () => db.stop();
}

// ---------------------------------------------------------------------------------- Testcontainers

async function startContainer(ownerPw: string, appPw: string): Promise<Database> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const name = 'expense_claims';
  const started = await new PostgreSqlContainer(IMAGE)
    .withDatabase(name)
    .withUsername('postgres')
    .withPassword(secret())
    .withEnvironment({ DB_OWNER_PASSWORD: ownerPw, DB_APP_PASSWORD: appPw })
    .withCopyFilesToContainer([
      // the SAME roles + REVOKEs as compose and production
      { source: ROLES_SCRIPT, target: '/docker-entrypoint-initdb.d/01-roles.sh', mode: 0o755 },
    ])
    .withTmpFs({ '/var/lib/postgresql': 'rw' }) // PG 18 keeps PGDATA below this
    .withCommand([
      'postgres',
      ...['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    ])
    .start()
    .catch((err: unknown) => {
      throw new Error(
        `Testcontainers could not start ${IMAGE}. Start Docker, or set TEST_PG_SUPERUSER_URL ` +
          `to a disposable PostgreSQL 18 superuser URL (see tests/helpers/global-setup.ts).`,
        { cause: err },
      );
    });
  const host = started.getHost();
  const port = started.getPort();
  return {
    name,
    url: (user, password) => `postgresql://${user}:${password}@${host}:${port}/${name}`,
    superUrl: started.getConnectionUri(),
    stop: async () => {
      await started.stop();
    },
  };
}

// ------------------------------------------------------------------ external cluster (no Docker)

async function createExternalDatabase(
  superuserUrl: string,
  ownerPw: string,
  appPw: string,
): Promise<Database> {
  const name = `${TEST_DB_PREFIX}${randomBytes(4).toString('hex')}`;
  const withDb = (db: string, user?: string, password?: string) => {
    const u = new URL(superuserUrl);
    u.pathname = `/${db}`;
    if (user !== undefined) u.username = user;
    if (password !== undefined) u.password = password;
    return u.toString();
  };
  const maintenanceDb = decodeURIComponent(new URL(superuserUrl).pathname.slice(1)) || 'postgres';
  const superUser = decodeURIComponent(new URL(superuserUrl).username);

  await withClient(superuserUrl, async (su) => {
    const { rows: [v] = [] } = await su.query<{ n: number }>(
      `SELECT current_setting('server_version_num')::int AS n`,
    );
    if (!v || v.n < 180000) throw new Error('TEST_PG_SUPERUSER_URL must point to PostgreSQL 18+');
    const { rows: foreign } = await su.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
        WHERE r.rolname = 'expense_owner' AND left(d.datname, length($1)) <> $1`,
      [TEST_DB_PREFIX],
    );
    if (foreign.length)
      throw new Error(
        `TEST_PG_SUPERUSER_URL points at a cluster with real expense databases ` +
          `(${foreign.map((r) => r.datname).join(', ')}); the harness would reset the ` +
          `expense_owner / expense_app passwords there. Use a disposable cluster.`,
      );
    await su.query(`CREATE DATABASE ${quoteIdent(name)}`); // like the image's POSTGRES_DB
  });

  const stop = async () => {
    await withClient(withDb(maintenanceDb), async (su) => {
      await su.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    });
  };

  try {
    await withClient(withDb(name), async (su) => {
      const statements = rolesScriptStatements({
        POSTGRES_USER: superUser,
        POSTGRES_DB: name,
        DB_OWNER_PASSWORD: ownerPw,
        DB_APP_PASSWORD: appPw,
      });
      for (const sql of statements) {
        try {
          await su.query(sql);
        } catch (err) {
          // Roles outlive databases. ALTER ROLE accepts the same options, so re-running the
          // statement as ALTER re-asserts every attribute and sets this run's password.
          if (sqlState(err) === '42710' && /^CREATE ROLE\b/i.test(sql))
            await su.query(sql.replace(/^CREATE ROLE\b/i, 'ALTER ROLE'));
          else throw err;
        }
      }
    });
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }

  return {
    name,
    url: (user, password) => withDb(name, user, password),
    superUrl: withDb(name),
    stop,
  };
}

/**
 * The SQL that 01-roles.sh feeds to psql, with psql's `-v name="$VAR"` bindings resolved
 * (`:'name'` → literal, `:"name"` → identifier). Comments are stripped before splitting on `;`.
 */
function rolesScriptStatements(env: Record<string, string>): string[] {
  const script = readFileSync(ROLES_SCRIPT, 'utf8');
  const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\2[ \t]*(?:\n|$)/.exec(script);
  if (!heredoc?.[3]) throw new Error(`${ROLES_SCRIPT}: no psql heredoc found`);
  const vars = new Map<string, string>();
  for (const [, name, envName] of script.matchAll(/-v\s+(\w+)=["']?\$\{?(\w+)\}?["']?/g)) {
    const value = env[envName ?? ''];
    if (name && value !== undefined) vars.set(name, value);
  }
  const value = (name: string) => {
    const v = vars.get(name);
    if (v === undefined) throw new Error(`${ROLES_SCRIPT}: psql variable :${name} is not bound`);
    return v;
  };
  return heredoc[3]
    .replace(/--.*$/gm, '')
    .replace(/:'(\w+)'/g, (_, n: string) => quoteLiteral(value(n)))
    .replace(/:"(\w+)"/g, (_, n: string) => quoteIdent(value(n)))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------------------- shared steps

function migrateDeploy(ownerUrl: string) {
  try {
    // prisma.config.ts reads MIGRATE_DATABASE_URL ?? DATABASE_URL: the CLI runs as the owner.
    execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MIGRATE_DATABASE_URL: ownerUrl,
        DATABASE_URL: ownerUrl,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        CHECKPOINT_DISABLE: '1',
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`prisma migrate deploy failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
      cause: err,
    });
  }
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: 'vitest-global-setup' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const sqlState = (err: unknown) => (err as { code?: unknown } | null)?.code;
