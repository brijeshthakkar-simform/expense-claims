// Harness: embedded Postgres 18 cluster, roles, Prisma migrate deploy, pg connections, a tiny test runner.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname;
export const PORT = 54417;
const SU_PW = 'su-local-only';
export const OWNER_PW = 'owner-local-only';
export const APP_PW = 'app-local-only';

// timestamps come back as strings so we can compare them exactly
pg.types.setTypeParser(1184, (v) => v); // timestamptz
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(20, (v) => BigInt(v)); // int8

let cluster;
export async function startCluster() {
  const dir = join(ROOT, 'out/pgdata');
  rmSync(dir, { recursive: true, force: true });
  cluster = new EmbeddedPostgres({
    databaseDir: dir,
    port: PORT,
    user: 'postgres',
    password: SU_PW,
    authMethod: 'scram-sha-256',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'timezone=UTC',
      '-c', 'log_min_messages=warning', '-c', 'max_connections=100'],
    onLog: () => {},
    onError: (e) => { const s = String(e); if (!/NOTICE|WARNING|LOG:/.test(s) && s.trim()) process.stderr.write(`[pg] ${s}\n`); },
  });
  await cluster.initialise();
  await cluster.start();
}
export async function stopCluster() { if (cluster) await cluster.stop(); }

export const url = (user, pw, db) => `postgresql://${user}:${encodeURIComponent(pw)}@127.0.0.1:${PORT}/${db}`;
export const suUrl = (db = 'postgres') => url('postgres', SU_PW, db);
export const ownerUrl = (db) => url('expense_owner', OWNER_PW, db);
export const appUrl = (db) => url('expense_app', APP_PW, db);

export async function connect(connStr, appName = 'sqlproof') {
  const c = new pg.Client({ connectionString: connStr, application_name: appName });
  c.on('notice', () => {});
  await c.connect();
  return c;
}

// ---- 01-roles.sh emulation ---------------------------------------------------
let rolesCreated = false;
export async function applyRoles(db) {
  const tpl = readFileSync(join(ROOT, 'sql/00_roles.sql'), 'utf8')
    .replaceAll('{{OWNER_PW}}', OWNER_PW).replaceAll('{{APP_PW}}', APP_PW).replaceAll('{{DB}}', db);
  const [clusterPart, rest] = tpl.split('-- @@DB');
  const [dbPart, inDbPart] = rest.split('-- @@IN_DB');
  const su = await connect(suUrl());
  if (!rolesCreated) { await su.query(clusterPart); rolesCreated = true; }
  for (const stmt of dbPart.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) await su.query(stmt);
  await su.end();
  const suDb = await connect(suUrl(db));
  await suDb.query(inDbPart.replace(/^.*?\n/, ''));
  await suDb.end();
}

// ---- Prisma CLI ----------------------------------------------------------------
export function prisma(args, env = {}) {
  try {
    const out = execFileSync(join(ROOT, 'node_modules/.bin/prisma'), args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1', ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ---- tiny test runner ---------------------------------------------------------------
export const results = [];
let currentGroup = '';
export function group(name) { currentGroup = name; console.log(`\n## ${name}`); }
export async function test(id, name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ group: currentGroup, id, name, passed: true, notes: note ?? '', ms: Date.now() - t0 });
    console.log(`  PASS ${id} ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    results.push({ group: currentGroup, id, name, passed: false, notes: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '), ms: Date.now() - t0 });
    console.log(`  FAIL ${id} ${name} — ${String(e?.message ?? e)}`);
  }
}
export function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }
export function eq(actual, expected, msg) {
  const a = typeof actual === 'bigint' ? actual.toString() : JSON.stringify(actual);
  const b = typeof expected === 'bigint' ? expected.toString() : JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
/** Runs fn and expects it to throw a pg error with this SQLSTATE. Returns "SQLSTATE: message". */
export async function rejects(code, fn, msg = '') {
  try { await fn(); } catch (e) {
    if (e?.code === code) return `${code}: ${String(e.message).slice(0, 110)}`;
    throw new Error(`${msg} expected SQLSTATE ${code}, got ${e?.code ?? 'non-pg error'}: ${e?.message}`);
  }
  throw new Error(`${msg} expected SQLSTATE ${code}, but it succeeded`);
}
/** BEGIN … fn … COMMIT, rolling back on error (the error propagates, incl. deferred errors at COMMIT). */
export async function tx(client, fn) {
  await client.query('BEGIN');
  try { const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until backend `pid` is blocked on a lock (checked from a superuser monitor connection). */
export async function waitUntilBlocked(monitor, pid, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { rows } = await monitor.query('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return `${rows[0].wait_event_type}/${rows[0].wait_event}`;
    await sleep(25);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}
export async function pidOf(c) { return (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p; }
