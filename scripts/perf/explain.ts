// pnpm perf:explain [--month YYYY-MM] (tsx --conditions=react-server). The query-plan evidence for
// §6/§8 (D-48, 07 §12.2, 06 §7) over the dataset `pnpm perf:seed` loaded into expense_perf:
//   docs/perf/explain-export-after.txt   export batches (first, mid-period cursor, cursor inside the
//                                        planted approved_at tie group), claims_export_idx present
//   docs/perf/explain-export-before.txt  the same batches, claims_export_idx dropped
//   docs/perf/explain-queue.txt          PENDING queue page, busiest approver, last 30 IST days
//   docs/perf/explain-finance-list.txt   finance list page, default statuses, last 30 IST days
// Each capture is `PREPARE perf_q AS <sql>; EXPLAIN (ANALYZE, BUFFERS, SETTINGS) EXECUTE perf_q(…)`,
// so the plan is the custom plan the parameterised app query gets (run twice, the second kept).
//
// The SQL is the app's own, not a copy: the real repository/service functions run once through the
// app's Prisma client (getDb(), as expense_app), and the statement text and bind values are taken
// from the client's `query` event (the TC-I17 capture mechanism; getDb() emits it only when
// APP_ENV=test, so this process sets that). The export and finance texts are also asserted equal
// to approvedClaimsBatchSql() / financeListSql(), the builders the repositories send.
//
// Roles: every "after" plan runs as expense_app, like the app. A "before" plan needs the index
// dropped inside BEGIN … ROLLBACK (DDL is transactional, so nothing changes for good), and only the
// owner may drop it; expense_owner is not a member of expense_app (it can't SET ROLE), so "before"
// runs as expense_owner in that transaction. No table has row security, so the role doesn't change
// the plan; the header of each file records which role ran what.
//
// Exit 1 if an "after" plan doesn't have its expected shape (06 §7). P7's exit criterion: every
// export page is `Limit → Index Scan using claims_export_idx`, i.e. no Sort below the Limit (the
// per-claim LATERAL final-approver lookup has its own tiny top-1 Sort; the files report it).
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import nextEnv from '@next/env';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import type { Actor } from '../../src/server/auth/actor';
import {
  addDaysYmd,
  businessDayRangeToUtc,
  monthPeriod,
  todayInBusinessTz,
} from '../../src/shared/dates';

nextEnv.loadEnvConfig(process.cwd());

const TAG = '[perf:explain]';
const OUT_DIR = 'docs/perf';
const log = (msg: string) => console.log(`${TAG} ${msg}`);
function fail(msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------------- flags + URLs

const today = todayInBusinessTz();
const argv = process.argv.slice(2).filter((a) => a !== '--');
let month = monthPeriod(today, -1).from.slice(0, 7); // the last complete IST month
for (let i = 0; i < argv.length; i++) {
  const m = /^--month(?:=(.*))?$/.exec(argv[i] ?? '');
  const value = m ? (m[1] ?? argv[++i]) : undefined;
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    fail('usage: pnpm perf:explain [--month YYYY-MM]   (default: the last complete IST month)');
  month = value;
}

const ownerRaw = process.env.PERF_DATABASE_URL;
if (!ownerRaw) fail('PERF_DATABASE_URL is not set: the owner URL of expense_perf (.env.example)');
const ownerUrl = new URL(ownerRaw);
const perfDb = decodeURIComponent(ownerUrl.pathname.replace(/^\//, ''));
if (!perfDb.includes('perf')) fail(`refusing to run against "${perfDb}" (not a perf database)`);
// The app role's URL for the same database: the app's own DATABASE_URL with the perf database.
const appRaw = process.env.DATABASE_URL;
if (!appRaw) fail('DATABASE_URL (the expense_app URL) is not set');
const appUrl = new URL(appRaw);
if (decodeURIComponent(appUrl.username) !== 'expense_app')
  fail('DATABASE_URL must connect as expense_app: the "after" plans run as the app role');
appUrl.host = ownerUrl.host;
appUrl.pathname = ownerUrl.pathname;
// Before any src/server import: the app client points at expense_perf as expense_app, and emits
// its SQL as `query` events (client.ts: only when APP_ENV=test).
process.env.DATABASE_URL = appUrl.href;
process.env.APP_ENV = 'test';

const { getDb, disconnectDb } = await import('../../src/server/db/client');
const { env } = await import('../../src/server/env');
const exportRepo = await import('../../src/server/repositories/export.repo');
const { financeListSql } = await import('../../src/server/repositories/finance.repo');
const { listFinanceClaims } = await import('../../src/server/services/finance.service');
const approvalsService = await import('../../src/server/services/approvals.service');
const { ApprovalQueueQuery, FinanceClaimsQuery } = await import('../../src/shared/schemas/queries');

// ---------------------------------------------------------------------- SQL capture

interface Captured {
  text: string;
  params: unknown[];
}
const sink: Captured[] = [];
getDb().$on('query', (e) =>
  sink.push({ text: e.query, params: JSON.parse(e.params) as unknown[] }),
);

/** Runs `fn` (one app call) and returns the single statement it sent. */
async function captureOne<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<Captured & { result: T }> {
  sink.length = 0;
  const result = await fn();
  if (sink.length !== 1)
    throw new Error(`${label}: expected one statement, captured ${sink.length}`);
  return { ...sink[0]!, result };
}

const literal = (c: pg.Client, v: unknown): string =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number' || typeof v === 'bigint'
      ? String(v)
      : typeof v === 'boolean'
        ? String(v).toUpperCase()
        : c.escapeLiteral(String(v));

interface Run {
  label: string;
  role: string;
  dropped: string | null;
  prepare: string;
  execute: string;
  plan: string;
  nodes: string[];
  executionMs: number;
  planningMs: number;
}

/** PREPARE + EXPLAIN EXECUTE inside BEGIN … ROLLBACK, optionally with one index dropped first. */
async function capture(c: pg.Client, label: string, q: Captured, dropIndex?: string): Promise<Run> {
  const prepare = `PREPARE perf_q AS ${q.text.trim()}`;
  const execute = `EXECUTE perf_q(${q.params.map((v) => literal(c, v)).join(', ')})`;
  const [{ current_user: role } = { current_user: '?' }] = (
    await c.query<{ current_user: string }>('SELECT current_user')
  ).rows;
  await c.query('BEGIN');
  try {
    if (dropIndex) await c.query(`DROP INDEX public.${dropIndex}`); // rolled back below
    await c.query(prepare);
    // Twice: the first run warms the cache and is discarded (07 §12.4 measures a warm cache). Both
    // are custom plans: plan_cache_mode=auto plans the first five EXECUTEs with their values.
    await c.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${execute}`);
    const { rows } = await c.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${execute}`,
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const ms = (name: string) => Number(new RegExp(`${name} Time: ([\\d.]+) ms`).exec(plan)?.[1]);
    return {
      label,
      role,
      dropped: dropIndex ?? null,
      prepare,
      execute,
      plan,
      nodes: nodesOf(plan),
      executionMs: ms('Execution'),
      planningMs: ms('Planning'),
    };
  } finally {
    await c.query('ROLLBACK');
    await c.query('DEALLOCATE ALL');
  }
}

/** The plan's node lines ("Index Scan using … on …", "Sort", …) without costs and timings. */
function nodesOf(plan: string): string[] {
  return plan
    .split('\n')
    .filter((line, i) => i === 0 || line.includes('->'))
    .map((line) =>
      line
        .replace(/^\s*->\s*/, '')
        .replace(/\s+\(cost=.*$/, '')
        .trim(),
    );
}
const hasSort = (r: Run) => r.nodes.some((n) => /\bSort\b/.test(n));
/** "0.093 ms, shared hit=57": execution time and the root node's buffers. */
const outline = (r: Run) =>
  `${r.executionMs.toFixed(3)} ms, ` +
  (/Buffers: (.*)/.exec(r.plan)?.[1]?.trim() ?? 'no buffers line');
const sortKeys = (r: Run) => [...r.plan.matchAll(/Sort Key: (.*)/g)].map((m) => m[1]!.trim());
const uses = (r: Run, index: string) =>
  r.nodes.some((n) => n.includes(`Index Scan using ${index}`));
const indexCond = (r: Run, index: string) => {
  const lines = r.plan.split('\n');
  const at = lines.findIndex((l) => l.includes(`using ${index}`));
  return at < 0
    ? ''
    : (lines
        .slice(at + 1)
        .find((l) => l.includes('Index Cond:'))
        ?.trim() ?? '');
};

/**
 * The export page CTE: the Limit above the scan of `claims c`, as a node path ("Limit → Index Scan
 * using claims_export_idx on claims c" or "Limit → Sort → Seq Scan on claims c"), with that Limit's
 * actual total time and buffers, i.e. the cost of finding the batch, before the per-claim joins.
 */
function exportPage(r: Run): { path: string; ms: number; buffers: string } {
  const at = r.nodes.findIndex((n) => / on claims c$/.test(n));
  let top = at;
  while (top > 0 && r.nodes[top] !== 'Limit') top--;
  const lines = r.plan.split('\n');
  const nodeLines = lines.flatMap((l, i) => (i === 0 || l.includes('->') ? [i] : []));
  const limitLine = nodeLines[top] ?? 0;
  const ms = Number(/actual time=[\d.]+\.\.([\d.]+)/.exec(lines[limitLine] ?? '')?.[1]);
  const buffers =
    lines
      .slice(limitLine + 1, nodeLines[top + 1] ?? lines.length)
      .find((l) => l.trim().startsWith('Buffers:'))
      ?.trim()
      .replace(/^Buffers:\s*/, '') ?? '?';
  return { path: at < 0 ? '?' : r.nodes.slice(top, at + 1).join(' → '), ms, buffers };
}

// ----------------------------------------------------------------------------- reports

let gitSha = 'no commit yet (uncommitted working tree)';
try {
  gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  // a fresh repository has no HEAD yet
}

function report(file: string, title: string, header: string[], runs: Run[], verdict: string[]) {
  const body = runs.flatMap((r) => [
    '',
    '='.repeat(100),
    `## ${r.label}`,
    `-- run as ${r.role} inside ` +
      (r.dropped
        ? `BEGIN; DROP INDEX public.${r.dropped}; … ROLLBACK`
        : 'BEGIN … ROLLBACK (no DDL)'),
    `-- nodes: ${r.nodes.join(' → ')}`,
    `-- planning ${r.planningMs.toFixed(3)} ms, execution ${r.executionMs.toFixed(3)} ms ` +
      '(the second of two runs; the first warmed the cache)',
    '',
    `${r.prepare};`,
    '',
    `EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${r.execute};`,
    '',
    r.plan,
  ]);
  const text = [
    `# ${file} — ${title}`,
    ...header.map((h) => `# ${h}`),
    '#',
    ...verdict.map((v) => `# ${v}`),
    ...body,
    '',
  ].join('\n');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${file}`, text);
  log(`wrote ${OUT_DIR}/${file}`);
}

// ------------------------------------------------------------------------------- main

const owner = new pg.Client({
  connectionString: ownerUrl.href,
  application_name: 'expense-perf-explain',
});
const app = new pg.Client({
  connectionString: appUrl.href,
  application_name: 'expense-perf-explain',
});
let exitCode = 0;
try {
  await owner.connect();
  await app.connect();
  const one = async <R extends pg.QueryResultRow>(
    c: pg.Client,
    text: string,
    values: unknown[] = [],
  ) => {
    const row = (await c.query<R>(text, values)).rows[0];
    if (!row) throw new Error(`no row: ${text}`);
    return row;
  };

  // The dataset, for every header.
  const version = (await one<{ v: string }>(owner, 'SELECT version() AS v')).v;
  const counts = await one<Record<string, number>>(
    owner,
    `SELECT (SELECT count(*) FROM claims)::int AS claims,
            (SELECT count(*) FROM claims WHERE status = 'APPROVED')::int AS approved,
            (SELECT count(*) FROM claims WHERE status = 'REJECTED')::int AS rejected,
            (SELECT count(*) FROM claims WHERE status = 'SUBMITTED')::int AS submitted,
            (SELECT count(*) FROM claims WHERE status = 'DRAFT')::int AS draft,
            (SELECT count(*) FROM line_items)::int AS line_items,
            (SELECT count(*) FROM claim_submissions)::int AS claim_submissions,
            (SELECT count(*) FROM approval_steps)::int AS approval_steps,
            (SELECT count(*) FROM approval_steps WHERE status = 'PENDING')::int AS pending_steps,
            (SELECT count(*) FROM claim_events)::int AS claim_events,
            (SELECT count(*) FROM users)::int AS users,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relrowsecurity)::int AS rls_tables`,
  );
  if (counts.claims === 0) throw new Error(`${perfDb} has no claims: run pnpm perf:seed first`);
  const seedFlags = existsSync(`${OUT_DIR}/seed-summary.txt`)
    ? (/^flags:\s+(.*)$/m.exec(readFileSync(`${OUT_DIR}/seed-summary.txt`, 'utf8'))?.[1] ?? '?')
    : '?';
  const header = (sqlSource: string, params: string[]) => [
    `generated: ${new Date().toISOString()} by pnpm perf:explain (scripts/perf/explain.ts)`,
    `git: ${gitSha}`,
    `server: ${version}`,
    `database: ${perfDb}, loaded by pnpm perf:seed ${seedFlags}`,
    `rows: claims ${counts.claims} (APPROVED ${counts.approved}, REJECTED ${counts.rejected}, ` +
      `SUBMITTED ${counts.submitted}, DRAFT ${counts.draft}), line_items ${counts.line_items}, ` +
      `claim_submissions ${counts.claim_submissions}, approval_steps ${counts.approval_steps} ` +
      `(PENDING ${counts.pending_steps}), claim_events ${counts.claim_events}, users ${counts.users}`,
    `roles: "after" runs as expense_app (the app's role); "before" as expense_owner, the only ` +
      `role that may DROP the index (inside BEGIN … ROLLBACK). Tables with row security: ` +
      `${counts.rls_tables}, so the role does not change the plan.`,
    `SQL: ${sqlSource}`,
    ...params,
  ];

  // ----------------------------------------------------------------- export batches
  const fin = await one<Actor>(
    owner,
    `SELECT id, email, name, role::text AS role, can_approve AS "canApprove"
       FROM users WHERE email = 'fin1@perf.test'`,
  );
  const ctx = (actor: Actor) => ({ actor, requestId: 'perf-explain-capture' });
  const from = `${month}-01`;
  const to = monthPeriod(from).to;
  const { gte, lt } = businessDayRangeToUtc(from, to) as { gte: Date; lt: Date };
  const limit = env().EXPORT_BATCH_SIZE;
  const asOf = await exportRepo.asOfNow();
  const inPeriod = await one<{ n: number }>(
    owner,
    `SELECT count(*)::int AS n FROM claims
      WHERE status = 'APPROVED' AND approved_at >= $1 AND approved_at < $2 AND approved_at < $3`,
    [gte, lt, asOf],
  );
  const half = Math.floor(inPeriod.n / 2);
  const mid = await one<{ approved_at: Date; id: string }>(
    owner,
    `SELECT approved_at, id FROM claims
      WHERE status = 'APPROVED' AND approved_at >= $1 AND approved_at < $2 AND approved_at < $3
      ORDER BY approved_at, id OFFSET $4 LIMIT 1`,
    [gte, lt, asOf, half],
  );
  // The largest group of claims sharing one approved_at (perf:seed plants 50): a cursor in its
  // middle shows the (approved_at, id) row comparison resolving ties inside the index.
  const tie = (
    await owner.query<{ approved_at: Date; n: number; id: string }>(
      `SELECT approved_at, count(*)::int AS n, (array_agg(id ORDER BY id))[count(*) / 2] AS id
         FROM claims
        WHERE status = 'APPROVED' AND approved_at >= $1 AND approved_at < $2 AND approved_at < $3
        GROUP BY approved_at HAVING count(*) > 1 ORDER BY count(*) DESC, approved_at LIMIT 1`,
      [gte, lt, asOf],
    )
  ).rows[0];
  const batchArgs = [
    { label: 'Batch 1: the first batch of the period (no cursor)', after: null },
    {
      label: `Batch 2: mid-period, keyset cursor after row ${half + 1} of ${inPeriod.n}`,
      after: { approvedAt: mid.approved_at, id: mid.id },
    },
    ...(tie
      ? [
          {
            label:
              `Batch 3: keyset cursor inside the ${tie.n} claims sharing approved_at ` +
              `${tie.approved_at.toISOString()} (after the ${Math.floor(tie.n / 2)}th)`,
            after: { approvedAt: tie.approved_at, id: tie.id },
          },
        ]
      : []),
  ];
  const exportCaptures: { label: string; q: Captured; rows: number }[] = [];
  for (const b of batchArgs) {
    const args = { gte, lt, asOf, after: b.after, limit };
    const q = await captureOne(b.label, () => exportRepo.approvedClaimsBatch(fin, args));
    const built = exportRepo.approvedClaimsBatchSql(args);
    if (
      q.text !== built.text ||
      JSON.stringify(q.params) !== JSON.stringify(JSON.parse(JSON.stringify(built.values)))
    )
      throw new Error(`${b.label}: the captured statement differs from approvedClaimsBatchSql()`);
    exportCaptures.push({ label: b.label, q, rows: q.result.length });
  }
  const exportAfter: Run[] = [];
  const exportBefore: Run[] = [];
  for (const e of exportCaptures)
    exportAfter.push(await capture(app, `${e.label} — ${e.rows} claims`, e.q));
  for (const e of exportCaptures)
    exportBefore.push(
      await capture(owner, `${e.label} — ${e.rows} claims`, e.q, 'claims_export_idx'),
    );
  const exportParams = [
    `period: ${from} … ${to} IST = approved_at in [${gte.toISOString()}, ${lt.toISOString()}), ` +
      `asOf ${asOf.toISOString()}, LIMIT ${limit} (EXPORT_BATCH_SIZE); ` +
      `${inPeriod.n} approved claims in the period`,
    ...exportCaptures.map(
      (e, i) =>
        `${e.label.split(':')[0]}: ${e.rows} claims; cursor ${JSON.stringify(batchArgs[i]!.after)}`,
    ),
  ];
  const exportSource =
    'captured from the app Prisma client (query event) while ' +
    'exportRepo.approvedClaimsBatch(fin1, args) ran as expense_app; asserted byte-identical to ' +
    'approvedClaimsBatchSql(args).text and .values';
  const INDEX_PAGE = 'Limit → Index Scan using claims_export_idx on claims c';
  // When the rest of the period fits in one batch (the Limit cuts nothing), the planner may read
  // it with a bitmap scan of the SAME index and sort just those rows. That is still O(batch): no
  // row outside the period is read, and the Sort's input is at most EXPORT_BATCH_SIZE rows. The
  // check below demands both, so a Sort over a Seq Scan or over more than one batch still fails.
  const BITMAP_PAGE = 'Limit → Sort → Bitmap Heap Scan on claims c';
  const heapRows = (r: Run) =>
    Number(
      /Bitmap Heap Scan on claims c\s.*\(actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+)/.exec(
        r.plan,
      )?.[1] ?? Number.NaN,
    );
  const boundedSort = (r: Run) =>
    exportPage(r).path === BITMAP_PAGE &&
    r.nodes.includes('Bitmap Index Scan on claims_export_idx') &&
    heapRows(r) <= limit;
  const exportPass = (r: Run, i: number) =>
    (exportPage(r).path === INDEX_PAGE || boundedSort(r)) &&
    (batchArgs[i]!.after === null ||
      /ROW\(approved_at, id\) > ROW\(/.test(indexCond(r, 'claims_export_idx')));
  const exportOk = exportAfter.every(exportPass);
  // Sort nodes other than a bounded page Sort (the final-approver LATERAL is a backward scan of
  // approval_steps_submission_id_level_key with LIMIT 1, so it should add none).
  const otherSorts = [
    ...new Set(
      exportAfter.flatMap((r) =>
        sortKeys(r).filter((k) => !(boundedSort(r) && k === 'c.approved_at, c.id')),
      ),
    ),
  ];
  const pageLine = (r: Run) => {
    const pg = exportPage(r);
    return `page ${pg.path} (${pg.ms.toFixed(3)} ms, Buffers: ${pg.buffers})`;
  };
  report(
    'explain-export-after.txt',
    'export batch WITH claims_export_idx (06 §6.6, 07 §12.2)',
    header(exportSource, exportParams),
    exportAfter,
    [
      `expect (P7 exit criterion): the page is "${INDEX_PAGE}", i.e. no Sort below the Limit, with`,
      `  Index Cond ROW(approved_at, id) > ROW(…) on a cursor batch; shared hits only. Accepted`,
      `  too when the rest of the period fits in one batch: "${BITMAP_PAGE}" whose bitmap is`,
      `  claims_export_idx and whose heap scan returns at most LIMIT (${limit}) rows, so the Sort`,
      `  orders only this batch's rows (still O(batch); the planner's choice when the Limit cuts`,
      `  nothing, and it depends on the heap's physical order).`,
      ...exportAfter.map(
        (r, i) =>
          `${exportPass(r, i) ? 'PASS' : 'FAIL'}: ${r.label.split(':')[0]}: ${pageLine(r)}` +
          (boundedSort(r) ? ` (bounded Sort of ${heapRows(r)} ≤ ${limit} rows)` : '') +
          `; statement ${r.executionMs.toFixed(3)} ms`,
      ),
      `other Sort nodes: ${otherSorts.join('; ') || 'none'}` +
        (otherSorts.length
          ? ''
          : ` (the final-approver LATERAL is "Limit → Index Scan Backward using ` +
            `approval_steps_submission_id_level_key", then users_pkey)`),
    ],
  );
  report(
    'explain-export-before.txt',
    'the same export batches WITHOUT claims_export_idx (dropped inside BEGIN … ROLLBACK)',
    header(exportSource, exportParams),
    exportBefore,
    [
      `expect: Seq Scan on claims with the period as a row-by-row Filter, then a Sort, for EVERY ` +
        `batch`,
      ...exportBefore.map((r, i) => {
        const after = exportAfter[i]!;
        return (
          `${r.label.split(':')[0]}: ${pageLine(r)}; statement ${r.executionMs.toFixed(3)} ms ` +
          `(after: page ${exportPage(after).ms.toFixed(3)} ms, statement ` +
          `${after.executionMs.toFixed(3)} ms)`
        );
      }),
    ],
  );

  // ------------------------------------------------------------------- queue page
  const last30 = { from: addDaysYmd(today, -29), to: today };
  const busiest = await one<Actor & { pending: number; recent: number }>(
    owner,
    `SELECT u.id, u.email, u.name, u.role::text AS role, u.can_approve AS "canApprove",
            count(*)::int AS pending,
            count(*) FILTER (WHERE s.activated_at >= $1 AND s.activated_at < $2)::int AS recent
       FROM approval_steps s JOIN users u ON u.id = s.approver_id
      WHERE s.status = 'PENDING'
      GROUP BY u.id ORDER BY count(*) DESC, u.email LIMIT 1`,
    [
      businessDayRangeToUtc(last30.from, last30.to).gte,
      businessDayRangeToUtc(last30.from, last30.to).lt,
    ],
  );
  const approver: Actor = {
    id: busiest.id,
    email: busiest.email,
    name: busiest.name,
    role: busiest.role,
    canApprove: busiest.canApprove,
  };
  const queueQuery = ApprovalQueueQuery.parse({ ...last30 });
  const queue = await captureOne('queue page', () =>
    approvalsService.listQueue(ctx(approver), queueQuery),
  );
  const queueAfter = await capture(
    app,
    `PENDING queue page — ${queue.result.items.length} rows`,
    queue,
  );
  const queueBefore = await capture(
    owner,
    `PENDING queue page, its index dropped — ${queue.result.items.length} rows`,
    queue,
    'approval_steps_pending_queue_idx',
  );
  const queueOk =
    uses(queueAfter, 'approval_steps_pending_queue_idx') &&
    /activated_at >=/.test(indexCond(queueAfter, 'approval_steps_pending_queue_idx')) &&
    !hasSort(queueAfter);
  report(
    'explain-queue.txt',
    'approver queue, PENDING page, before + after (06 §7, 07 §12.2)',
    header(
      'captured from the app Prisma client (query event) while approvals.service ' +
        'listQueue(ctx, ApprovalQueueQuery.parse({from, to})) ran as expense_app (steps.repo ' +
        'listQueue has no exported builder; nothing was copied)',
      [
        `approver: ${busiest.email}, the busiest (most PENDING steps: ${busiest.pending}; ` +
          `${busiest.recent} activated in the window)`,
        `query: status=PENDING (default), from=${last30.from} to=${last30.to} (the last 30 IST ` +
          `days, on activated_at), limit 25 → LIMIT 26`,
      ],
    ),
    [queueBefore, queueAfter],
    [
      `expect after: Index Scan using approval_steps_pending_queue_idx, Index Cond (approver_id = ` +
        `… AND activated_at >= … AND activated_at < …), no Sort`,
      `${queueOk ? 'PASS' : 'FAIL'}: after ${outline(queueAfter)}; ` +
        (indexCond(queueAfter, 'approval_steps_pending_queue_idx') || 'no queue-index scan'),
      `before: ${outline(queueBefore)}; nodes: ${queueBefore.nodes.join(' → ')}`,
    ],
  );

  // ------------------------------------------------------------------ finance page
  const financeQuery = FinanceClaimsQuery.parse({ ...last30 });
  const finance = await captureOne('finance page', () => listFinanceClaims(ctx(fin), financeQuery));
  const builtFinance = financeListSql(fin, {
    statuses: financeQuery.status,
    dateField: financeQuery.dateField,
    range: businessDayRangeToUtc(financeQuery.from, financeQuery.to),
    take: financeQuery.limit + 1,
  });
  if (finance.text !== builtFinance.text)
    throw new Error('finance page: the captured statement differs from financeListSql()');
  const financeAfter = await capture(
    app,
    `finance list page — ${finance.result.items.length} rows`,
    finance,
  );
  const financeBefore = await capture(
    owner,
    `finance list page, claims_submitted_idx dropped — ${finance.result.items.length} rows`,
    finance,
    'claims_submitted_idx',
  );
  const financeOk = uses(financeAfter, 'claims_submitted_idx') && !hasSort(financeAfter);
  report(
    'explain-finance-list.txt',
    'finance list page, default statuses, before + after (06 §7, 07 §12.2)',
    header(
      'captured from the app Prisma client (query event) while finance.service ' +
        'listFinanceClaims(ctx, FinanceClaimsQuery.parse({from, to})) ran as expense_app; ' +
        'asserted byte-identical to financeListSql(actor, args).text',
      [
        `actor: fin1@perf.test (FINANCE)`,
        `query: status=SUBMITTED,APPROVED,REJECTED (default), dateField=submittedAt, ` +
          `from=${last30.from} to=${last30.to} (last 30 IST days), limit 25 → LIMIT 26`,
      ],
    ),
    [financeBefore, financeAfter],
    [
      `expect after: Index Scan using claims_submitted_idx, status as a Filter, no Sort`,
      `${financeOk ? 'PASS' : 'FAIL'}: after ${outline(financeAfter)}; ` +
        (indexCond(financeAfter, 'claims_submitted_idx') || 'no claims_submitted_idx scan'),
      `before: ${outline(financeBefore)}; nodes: ${financeBefore.nodes.join(' → ')}`,
    ],
  );

  const summary: [string, boolean, Run, Run][] = [
    ...exportAfter.map(
      (r, i) =>
        [
          `export ${r.label.split(':')[0]!.toLowerCase()}`,
          exportPass(r, i),
          r,
          exportBefore[i]!,
        ] as [string, boolean, Run, Run],
    ),
    ['queue page', queueOk, queueAfter, queueBefore],
    ['finance page', financeOk, financeAfter, financeBefore],
  ];
  for (const [what, ok, after, before] of summary)
    log(
      `${ok ? 'PASS' : 'FAIL'} ${what}: after ${outline(after)} [${after.nodes.join(' → ')}]` +
        ` | before ${outline(before)} [${before.nodes.join(' → ')}]`,
    );
  if (!exportOk || !queueOk || !financeOk) {
    log('FAIL: an "after" plan does not have the shape 06 §7 expects (see the files)');
    exitCode = 1;
  }
} catch (err) {
  console.error(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await owner.end().catch(() => {});
  await app.end().catch(() => {});
  await disconnectDb().catch(() => {});
}
process.exit(exitCode);
