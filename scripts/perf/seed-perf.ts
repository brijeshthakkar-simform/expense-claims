// pnpm perf:seed [--months 24] [--claims 10000] [--seed 42] [--until YYYY-MM-DD]
// (tsx --conditions=react-server). The §8 two-year dataset for the query-plan evidence (D-48).
// 07 §12.1 is the one spec; 03 §13 links to it. In short:
//   1. DROP + CREATE the SEPARATE database named by PERF_DATABASE_URL (the owner URL; never the
//      demo DB), apply the database part of docker/postgres/initdb/01-roles.sh to it (03 §16.1), then
//      `prisma migrate deploy` (the table grants and every trigger come from the migrations).
//   2. Reference data as the demo has it (+ L4_CFO inactive, designated to the perf CFO) and a
//      500-person org @perf.test whose manager_id chains feed the real tiers.
//   3. One transaction per IST calendar month: claims → lines (ONE set-based INSERT, so the
//      statement trigger recomputes the totals once) → snapshots built in SQL from the live rows →
//      chains from the REAL buildChain() → submit → decisions level by level → events. Runs as the
//      owner with ALL triggers on: the owner may supply backdated timestamps, but only at legal
//      transitions (D-23), so every row passes the total, snapshot, chain, eligibility and audit
//      checks (UC009/UC015 fire at each COMMIT and verify the generator's own output).
//   4. setval(claim_number_seq), VACUUM (ANALYZE), v_claim_total_drift must be empty, and
//      docs/perf/seed-summary.txt.
// A seeded PRNG (mulberry32) drives every choice, so the same flags give the same rows (ids are
// uuidv7 drawn by the DB, so only they differ between runs). --until (default: today in IST) ends
// the window at that day's 00:00 IST; pass it explicitly to reproduce an earlier run exactly.
//
// Default import: the named `loadEnvConfig` import fails under tsx in this "type": "module" repo.
import nextEnv from '@next/env';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { SeedSql } from '../../prisma/seed-personas';
import type { RoutingRow } from '../../src/server/repositories/users.repo';
import type { OrgLookup, PlannedStep, PolicyTier } from '../../src/server/routing/build-chain';
import {
  addDaysYmd,
  businessDateOf,
  businessMidnightUtc,
  isValidYmd,
  todayInBusinessTz,
} from '../../src/shared/dates';
import {
  BUSINESS_TIMEZONE,
  MAX_CLAIM_TOTAL_MINOR,
  MAX_LINE_AMOUNT_MINOR,
} from '../../src/shared/policy';

nextEnv.loadEnvConfig(process.cwd());

const TAG = '[perf:seed]';
const SUMMARY_FILE = 'docs/perf/seed-summary.txt';
const log = (msg: string) => console.log(`${TAG} ${msg}`);
function fail(msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------- flags

interface Flags {
  months: number;
  claims: number;
  seed: number;
  until: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const usage =
    'usage: pnpm perf:seed [--months 24] [--claims 10000] [--seed 42] [--until YYYY-MM-DD]';
  const raw: Record<string, string> = {};
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const m = /^--(months|claims|seed|until)(?:=(.*))?$/.exec(args[i] ?? '');
    const key = m?.[1];
    if (!m || !key) fail(`unknown argument ${args[i]}\n${usage}`);
    const value = m[2] ?? args[++i];
    if (value === undefined) fail(`--${key} needs a value\n${usage}`);
    raw[key] = value;
  }
  const int = (k: string, dflt: number, lo: number, hi: number): number => {
    const v = raw[k] === undefined ? dflt : Number(raw[k]);
    if (!Number.isSafeInteger(v) || v < lo || v > hi)
      fail(`--${k} must be an integer ${lo}..${hi}`);
    return v;
  };
  const today = todayInBusinessTz();
  const until = raw.until ?? today;
  if (!isValidYmd(until) || until > today)
    fail(`--until must be a YYYY-MM-DD date, at most ${today}`);
  return {
    months: int('months', 24, 1, 60),
    claims: int('claims', 10_000, 100, 200_000),
    seed: int('seed', 42, 0, 2 ** 31 - 1),
    until,
  };
}

const flags = parseFlags(process.argv.slice(2));
const flagLine =
  `--months ${flags.months} --claims ${flags.claims} --seed ${flags.seed}` +
  ` --until ${flags.until}`;

// ----------------------------------------------------------------------- connection + guards

const perfUrlRaw = process.env.PERF_DATABASE_URL;
if (!perfUrlRaw)
  fail('PERF_DATABASE_URL is not set: the OWNER URL of the separate perf DB (see .env.example)');
const perfUrl = new URL(perfUrlRaw);
const perfDb = decodeURIComponent(perfUrl.pathname.replace(/^\//, ''));
const dbOf = (u: string | undefined) =>
  u ? decodeURIComponent(new URL(u).pathname.replace(/^\//, '')) : undefined;
const mainDb = process.env.POSTGRES_DB || 'expense_claims';
// This script DROPs the database it is pointed at: refuse anything that could be the demo DB.
if (!/^[a-z_][a-z0-9_]*$/.test(perfDb) || !perfDb.includes('perf'))
  fail(
    `refusing to drop "${perfDb}": the perf database name must be a plain identifier with "perf"`,
  );
if (
  [mainDb, dbOf(process.env.DATABASE_URL), dbOf(process.env.MIGRATE_DATABASE_URL)].includes(perfDb)
)
  fail(`refusing to drop "${perfDb}": it is the demo/app database`);
if (['staging', 'production'].includes(process.env.APP_ENV ?? ''))
  fail(`refusing to run with APP_ENV=${process.env.APP_ENV}`);
if (decodeURIComponent(perfUrl.username) !== 'expense_owner')
  fail('PERF_DATABASE_URL must connect as expense_owner (the owner may supply backdated stamps)');
const demoPassword = process.env.SEED_DEMO_PASSWORD;
if (!demoPassword || demoPassword.length < 8)
  fail('SEED_DEMO_PASSWORD (≥ 8 chars) is needed: every @perf.test user gets its argon2id hash');

// The maintenance connection (DROP/CREATE DATABASE) goes to the demo DB as the same owner.
const adminUrl = new URL(perfUrl.href);
adminUrl.pathname = `/${mainDb}`;
// Contract (C-12 scripts): the owner URL is DATABASE_URL for this process before any src/server
// import, so nothing imported below can reach another database.
process.env.DATABASE_URL = perfUrl.href;

const { hashPassword } = await import('../../src/server/auth/password');
const { buildChain } = await import('../../src/server/routing/build-chain');
const { buildOrgLookup } = await import('../../src/server/routing/org-loader');
const { assertPolicyWellFormed } = await import('../../src/server/routing/policy');
const { ClaimEventInputSchema } = await import('../../src/server/audit/events');
const { L4_TIER, readTiers, seedReference, sqlOf } = await import('../../prisma/seed-personas');

// --------------------------------------------------------------------------------------- PRNG

/** mulberry32: a tiny 32-bit seeded PRNG (no faker), so a run is reproducible from its flags. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(flags.seed);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p: number) => rand() < p;
function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)] as T;
}
function weighted<T>(xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [x, w] of xs) if ((r -= w) < 0) return x;
  return xs[xs.length - 1]![0];
}
/** Standard normal (Box–Muller). */
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

// --------------------------------------------------------------------------- business time

// Instants are epoch ms. IST days come from the shared helpers (no hard-coded offset, 06 §4).
const HOUR = 3_600_000;
const BIZ_OPEN = 9 * HOUR;
const BIZ_CLOSE = 18 * HOUR;
const dayStart = (ymd: string) => businessMidnightUtc(ymd).getTime();
const ymdOf = (ms: number) => businessDateOf(new Date(ms));
const isWeekday = (ymd: string) => {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};
const iso = (ms: number) => new Date(ms).toISOString();

/** A weekday business-hours instant (09:00–18:00 IST) in [lo, hi). */
function bizBetween(lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const ymd = ymdOf(lo + Math.floor(rand() * (hi - lo)));
    if (!isWeekday(ymd)) continue;
    const t = dayStart(ymd) + BIZ_OPEN + Math.floor(rand() * (BIZ_CLOSE - BIZ_OPEN));
    if (t >= lo && t < hi) return t;
  }
  return lo + Math.floor(rand() * (hi - lo));
}

/** A weekday business-hours instant strictly before `t`, at most `maxDays` weekdays earlier. */
function bizBefore(t: number, maxDays: number): number {
  for (let i = 0; i < 200; i++) {
    let ymd = ymdOf(t);
    while (!isWeekday(ymd)) ymd = addDaysYmd(ymd, -1);
    for (let k = int(0, maxDays); k > 0; k--) {
      do ymd = addDaysYmd(ymd, -1);
      while (!isWeekday(ymd));
    }
    const lo = dayStart(ymd) + BIZ_OPEN;
    const hi = Math.min(dayStart(ymd) + BIZ_CLOSE, t);
    if (hi - lo >= 60_000) return lo + Math.floor(rand() * (hi - lo));
  }
  return t - HOUR;
}

// ------------------------------------------------------------------------------ the org

type Kind = 'cfo' | 'director' | 'head' | 'manager' | 'ic' | 'finance' | 'admin';
interface Person {
  kind: Kind;
  email: string;
  name: string;
  code: string;
  dept: string;
  role: 'EMPLOYEE' | 'FINANCE' | 'ADMIN';
  canApprove: boolean;
  fallback: boolean;
  manager: string | null;
}

const ORG = { directors: 4, heads: 12, managers: 45, ics: 431, finance: 6 } as const;
const PERF_DEPARTMENTS = [
  { code: 'SALES', name: 'Sales' },
  { code: 'OPS', name: 'Operations' },
] as const;
/** Director i's subtree (heads, managers, ICs) sits in DIRECTOR_DEPTS[i - 1]. */
const DIRECTOR_DEPTS = ['ENG', 'SALES', 'OPS', 'FIN'] as const;
// prettier-ignore
const FIRST = [
  'Aarav', 'Aditi', 'Anil', 'Bhavna', 'Chetan', 'Deepak', 'Divya', 'Farhan', 'Gauri', 'Harish',
  'Isha', 'Jatin', 'Kavya', 'Lakshmi', 'Manish', 'Nandini', 'Omkar', 'Pooja', 'Rahul', 'Sana',
  'Tanvi', 'Uday', 'Varun', 'Yamini', 'Zoya', 'Kiran', 'Meghna', 'Nikhil', 'Priya', 'Sameer',
];
// prettier-ignore
const LAST = [
  'Agarwal', 'Bose', 'Chatterjee', 'Desai', 'Fernandes', 'Ghosh', 'Iyengar', 'Joshi', 'Kulkarni',
  'Mehta', 'Nair', 'Pillai', 'Qureshi', 'Reddy', 'Sethi', 'Thomas', 'Verma', 'Wadia', 'Yadav',
  'Zaveri',
];

/** Five waves, managers before their reports so manager_id resolves by email on insert. */
function buildOrg(): Person[][] {
  let n = 0;
  const person = (kind: Kind, local: string, dept: string, manager: Person | null): Person => {
    const i = n++;
    return {
      kind,
      email: `${local}@perf.test`,
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
      code: `P${String(i + 1).padStart(5, '0')}`,
      dept,
      role: kind === 'finance' ? 'FINANCE' : kind === 'admin' ? 'ADMIN' : 'EMPLOYEE',
      canApprove: ['cfo', 'director', 'head', 'manager'].includes(kind),
      fallback: kind === 'cfo', // the CFO is also the fallback approver (C-13)
      manager: manager?.email ?? null,
    };
  };
  const many = (count: number, make: (i: number) => Person) =>
    Array.from({ length: count }, (_, i) => make(i));
  const pad = (x: number, w: number) => String(x + 1).padStart(w, '0');
  const cfo = person('cfo', 'cfo', 'EXEC', null);
  const dirs = many(ORG.directors, (i) =>
    person('director', `dir${i + 1}`, DIRECTOR_DEPTS[i]!, cfo),
  );
  const heads = many(ORG.heads, (i) => {
    const d = dirs[i % dirs.length]!;
    return person('head', `head${pad(i, 2)}`, d.dept, d);
  });
  const managers = many(ORG.managers, (i) => {
    const h = heads[i % heads.length]!;
    return person('manager', `mgr${pad(i, 3)}`, h.dept, h);
  });
  const ics = many(ORG.ics, (i) => {
    const m = managers[i % managers.length]!;
    return person('ic', `ic${pad(i, 3)}`, m.dept, m);
  });
  const finance = many(ORG.finance, (i) => person('finance', `fin${i + 1}`, 'FIN', dirs[3]!));
  const admin = person('admin', 'admin', 'EXEC', cfo);
  return [[cfo], dirs, heads, managers, ics, [...finance, admin]];
}

// ---------------------------------------------------------------------- claim content

/** 10 active categories (LEGACY_PER_DIEM is inactive: UC013). Median ₹ and log-normal sigma. */
const CATEGORY_MODEL: readonly (readonly [
  code: string,
  weight: number,
  medianRupees: number,
  sigma: number,
])[] = [
  ['MEALS', 22, 800, 0.6],
  ['LOCAL_TRANSPORT', 22, 450, 0.6],
  ['LODGING', 10, 4_500, 0.6],
  ['TRAVEL_AIR', 8, 6_500, 0.5],
  ['OFFICE_SUPPLIES', 8, 900, 0.8],
  ['INTERNET_PHONE', 8, 1_000, 0.4],
  ['MISC', 7, 600, 0.9],
  ['TRAVEL_RAIL', 6, 1_200, 0.6],
  ['CLIENT_ENTERTAINMENT', 6, 3_500, 0.8],
  ['TRAINING', 3, 8_000, 0.9],
];
// prettier-ignore
const DESCRIPTIONS: Record<string, readonly string[]> = {
  MEALS: ['Team lunch', 'Dinner during client visit', 'Working breakfast', 'Meals on travel day'],
  LOCAL_TRANSPORT: ['Cab to client office', 'Airport transfer', 'Auto to station', 'Metro top-up'],
  LODGING: ['Hotel, 2 nights', 'Hotel, 1 night', 'Service apartment, 3 nights', 'Guest house stay'],
  TRAVEL_AIR: ['Flight BLR to BOM', 'Return flight DEL to BLR', 'Flight HYD to MAA', 'Change fee'],
  OFFICE_SUPPLIES: ['Printer cartridges', 'Notebooks and pens', 'Laptop stand', 'Markers'],
  INTERNET_PHONE: ['Mobile bill', 'Home broadband, monthly', 'Data pack for travel', 'Hotspot'],
  MISC: ['Courier charges', 'Visa photo prints', 'Parking fees', 'Toll charges'],
  TRAVEL_RAIL: ['Train PUNE to BOM', 'Rajdhani 3AC', 'Shatabdi chair car', 'Tatkal booking'],
  CLIENT_ENTERTAINMENT: ['Client dinner', 'Client lunch meeting', 'Workshop snacks', 'Gala'],
  TRAINING: ['Cloud certification exam', 'Online course', 'Conference pass', 'Workshop fee'],
};
const MERCHANTS: Record<string, readonly string[]> = {
  MEALS: ['Spice Route Cafe', 'Green Leaf Diner', 'Udupi Corner'],
  LOCAL_TRANSPORT: ['CityCab', 'MetroRide', 'QuickAuto'],
  LODGING: ['Hotel Blue', 'Lakeview Residency', 'Comfort Suites'],
  TRAVEL_AIR: ['SkyJet Airways', 'BlueWing Air'],
  OFFICE_SUPPLIES: ['Paper Mart', 'Desk Depot'],
  INTERNET_PHONE: ['TelNet', 'AirLink Mobile'],
  MISC: ['Speedy Couriers', 'Print Hub'],
  TRAVEL_RAIL: ['Rail Booking Office'],
  CLIENT_ENTERTAINMENT: ['The Grand Pavilion', 'Harbour Bistro'],
  TRAINING: ['LearnPro Academy', 'TechConf India'],
};
/** A few CSV-injection payloads, so an export of the perf data exercises the neutralisation. */
// prettier-ignore
const FORMULA_DESCRIPTIONS = [
  '=SUM(1+1) team lunch', '+91 cab booking', '-10% corporate rate', '@office restock',
];
// prettier-ignore
const PURPOSES = [
  'Client visit', 'Team offsite', 'Conference', 'Customer onsite', 'Sales meeting',
  'Monthly expenses', 'Project kickoff', 'Vendor audit', 'Recruitment drive', 'Training trip',
];
// prettier-ignore
const CITIES = [
  'Pune', 'Mumbai', 'Bengaluru', 'Delhi', 'Chennai', 'Hyderabad', 'Kolkata', 'Ahmedabad', 'Jaipur',
  'Kochi',
];
const REJECT_REASONS = [
  'Hotel invoice missing for the stay',
  'Amount exceeds the per-diem policy limit',
  'Duplicate of an earlier claim',
  'Personal expense, not reimbursable',
  'Receipts are illegible; please re-upload them',
  'Wrong category: book this as client entertainment',
];
const APPROVE_COMMENTS = ['Approved', 'OK, within policy', 'Approved; thanks for the receipts'];
/** Tier thresholds (C-13): ≤ ₹10k one level, ≤ ₹50k two, above that three. */
const BANDS = [
  { share: 0.72, lo: 10_000, hi: 1_000_000 },
  { share: 0.23, lo: 1_000_001, hi: 5_000_000 },
  { share: 0.05, lo: 5_000_001, hi: 30_000_000 },
] as const;
/** Every 250th submitted claim gets a total exactly at or just above a tier threshold. */
const THRESHOLD_TOTALS = [1_000_000, 1_000_001, 5_000_000, 5_000_001] as const;
const STATUS_MIX = { APPROVED: 0.87, REJECTED: 0.05, SUBMITTED: 0.04 } as const; // rest DRAFT
const TIE_COUNT = 50;
// prettier-ignore
const SUMMARY_TABLES = [
  'departments', 'users', 'categories', 'approval_policy_tiers', 'claims', 'line_items',
  'claim_submissions', 'approval_steps', 'claim_events', 'receipts', 'sessions',
] as const;
const RECENT_DAYS = 42; // "in flight mostly in the last 6 weeks"

// ------------------------------------------------------------------------------- planning

type Outcome = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
interface LinePlan {
  category: string;
  expenseDate: string;
  amountMinor: number;
  description: string;
  merchant: string | null;
}
interface ClaimPlan {
  claimNumber: string;
  claimantId: string;
  title: string;
  createdAt: number;
  lines: LinePlan[];
  totalMinor: number;
  outcome: Outcome;
  chain: PlannedStep[];
  submittedAt: number | null;
  /** decided_at of every APPROVED level, in level order (level k+1 activates at level k's). */
  approvals: { at: number; comment: string | null }[];
  rejection: { level: number; at: number; reason: string } | null;
  /** The instant the claim reached its final state: picks its month (transaction). */
  anchor: number;
}

function planLines(totalMinor: number, createdAt: number): LinePlan[] {
  // 1–8 lines, mean 4: 1 + Binomial(7, 3/7)
  const n = 1 + Array.from({ length: 7 }, () => chance(3 / 7)).filter(Boolean).length;
  const raw = Array.from({ length: n }, () => {
    const [category, , median, sigma] = weighted(CATEGORY_MODEL.map((c) => [c, c[1]] as const));
    return { category, weight: median * 100 * Math.exp(sigma * normal()) };
  });
  // Log-normal per category shapes the lines; scaling hits the claim's band exactly.
  const sum = raw.reduce((s, l) => s + l.weight, 0);
  const amounts = raw.map((l) => Math.max(1, Math.round((l.weight * totalMinor) / sum)));
  const drift = totalMinor - amounts.reduce((s, a) => s + a, 0);
  const big = amounts.indexOf(Math.max(...amounts));
  amounts[big] = amounts[big]! + drift;
  const createdYmd = ymdOf(createdAt);
  return raw.map((l, i) => ({
    category: l.category,
    expenseDate: addDaysYmd(createdYmd, -int(0, 30)),
    amountMinor: amounts[i]!,
    description: chance(0.005) ? pick(FORMULA_DESCRIPTIONS) : pick(DESCRIPTIONS[l.category]!),
    merchant: chance(0.2) ? null : pick(MERCHANTS[l.category]!),
  }));
}

function bandTotal(): number {
  const r = rand();
  const band =
    r < BANDS[0].share ? BANDS[0] : r < BANDS[0].share + BANDS[1].share ? BANDS[1] : BANDS[2];
  return Math.round(Math.exp(Math.log(band.lo) + rand() * (Math.log(band.hi) - Math.log(band.lo))));
}

interface Window {
  start: number;
  end: number;
  months: string[];
}

/** --months IST calendar months ending with the month of the day before --until 00:00 IST. */
function windowOf(f: Flags): Window {
  const end = dayStart(f.until);
  const last = ymdOf(end - 1).slice(0, 7);
  const months: string[] = [];
  for (let i = f.months - 1; i >= 0; i--) {
    const [y, m] = last.split('-').map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return { start: dayStart(`${months[0]}-01`), end, months };
}

/**
 * Every claim's content and timeline, before any write. Anchors (approved_at, rejected_at, the
 * pending level's activated_at, a draft's created_at) are chosen first and the timeline is walked
 * backwards from them, so every stamp is in the past and strictly ordered.
 */
function planClaims(
  f: Flags,
  w: Window,
  claimants: readonly string[],
  managerClaimants: readonly string[],
  tiers: readonly PolicyTier[],
  org: OrgLookup,
): { plans: ClaimPlan[]; edges: { midnight: number; lastMs: number }; tieAt: number } {
  const counts = {
    APPROVED: Math.round(f.claims * STATUS_MIX.APPROVED),
    REJECTED: Math.round(f.claims * STATUS_MIX.REJECTED),
    SUBMITTED: Math.round(f.claims * STATUS_MIX.SUBMITTED),
  };
  const outcomes = shuffle([
    ...Array<Outcome>(counts.APPROVED).fill('APPROVED'),
    ...Array<Outcome>(counts.REJECTED).fill('REJECTED'),
    ...Array<Outcome>(counts.SUBMITTED).fill('SUBMITTED'),
    ...Array<Outcome>(f.claims - counts.APPROVED - counts.REJECTED - counts.SUBMITTED).fill(
      'DRAFT',
    ),
  ]);

  // Deliberate edge values on approved_at: each month's first instant (00:00:00.000 IST) and last
  // (23:59:59.999 IST), and TIE_COUNT claims sharing one instant in the last complete month (the
  // month the EXPLAIN capture exports), so keyset tie-breaking is exercised at scale.
  const overrides: number[] = [];
  let midnight = 0;
  let lastMs = 0;
  for (const m of w.months) {
    const first = dayStart(`${m}-01`);
    const next = dayStart(`${addDaysYmd(`${m}-28`, 7).slice(0, 7)}-01`);
    if (first >= w.start && first < w.end) {
      overrides.push(first);
      midnight++;
    }
    if (next - 1 < w.end) {
      overrides.push(next - 1);
      lastMs++;
    }
  }
  const tieMonth = w.months[w.months.length - (ymdOf(w.end).endsWith('-01') ? 1 : 2)]!;
  let tieDay = `${tieMonth}-15`;
  while (!isWeekday(tieDay)) tieDay = addDaysYmd(tieDay, 1);
  const tieAt = dayStart(tieDay) + 11 * HOUR;
  for (let i = 0; i < TIE_COUNT; i++) overrides.push(tieAt);

  const plans: Omit<ClaimPlan, 'claimNumber'>[] = [];
  let submittedSeen = 0;
  for (const outcome of outcomes) {
    const claimantId = chance(0.9) ? pick(claimants) : pick(managerClaimants);
    let totalMinor = bandTotal();
    if (outcome !== 'DRAFT' && ++submittedSeen % 250 === 0)
      totalMinor = THRESHOLD_TOTALS[(submittedSeen / 250) % THRESHOLD_TOTALS.length]!;
    if (totalMinor > MAX_CLAIM_TOTAL_MINOR) throw new Error('total out of range');
    const claimant = org.get(claimantId);
    if (!claimant) throw new Error(`claimant ${claimantId} is not in the org lookup`);
    // The REAL router (pure): the same chain the submit service would plan for this total.
    const chain = outcome === 'DRAFT' ? [] : buildChain({ tiers, claimant, org, totalMinor });
    const n = chain.length;

    let anchor: number;
    let submittedAt: number | null = null;
    let createdAt: number;
    const approvals: ClaimPlan['approvals'] = [];
    let rejection: ClaimPlan['rejection'] = null;
    /** decided_at of levels 1..k-1, walked backwards from `top` (level k's activation). */
    const approvedUpTo = (k: number, top: number) => {
      const at: number[] = [];
      let t = top;
      for (let level = k - 1; level >= 1; level--) {
        at.unshift(t);
        t = bizBefore(t, 3);
      }
      for (const a of at)
        approvals.push({ at: a, comment: chance(0.3) ? pick(APPROVE_COMMENTS) : null });
      return t; // level 1's activation = submitted_at
    };

    if (outcome === 'DRAFT') {
      anchor = createdAt = bizBetween(w.start, w.end);
    } else {
      if (outcome === 'APPROVED') {
        anchor = overrides.pop() ?? bizBetween(w.start, w.end);
        // Levels 1..n-1 walked back from level n's activation; level n decides at the anchor.
        submittedAt = approvedUpTo(n, bizBefore(anchor, 3));
        approvals.push({ at: anchor, comment: chance(0.3) ? pick(APPROVE_COMMENTS) : null });
      } else if (outcome === 'REJECTED') {
        anchor = bizBetween(w.start, w.end);
        const level = chance(0.7) ? 1 : int(1, n);
        rejection = { level, at: anchor, reason: pick(REJECT_REASONS) };
        submittedAt =
          level === 1 ? bizBefore(anchor, 3) : approvedUpTo(level, bizBefore(anchor, 3));
      } else {
        const recent = chance(0.85);
        const lo = recent ? Math.max(w.start, w.end - RECENT_DAYS * 24 * HOUR) : w.start;
        const hi = recent ? w.end : Math.max(w.start + HOUR, w.end - RECENT_DAYS * 24 * HOUR);
        anchor = bizBetween(lo, hi); // the PENDING level's activated_at
        const pendingLevel = chance(0.6) ? 1 : int(1, n);
        submittedAt = pendingLevel === 1 ? anchor : approvedUpTo(pendingLevel, anchor);
      }
      createdAt = bizBefore(submittedAt, 5);
    }
    if (outcome === 'APPROVED' && submittedAt !== null && approvals.length !== n)
      throw new Error('planner: approvals do not cover the chain');
    const lines = planLines(totalMinor, createdAt);
    for (const l of lines)
      if (l.amountMinor < 1 || l.amountMinor > MAX_LINE_AMOUNT_MINOR)
        throw new Error('line amount out of range');
    plans.push({
      claimantId,
      title: `${pick(PURPOSES)} ${pick(CITIES)}`,
      createdAt,
      lines,
      totalMinor,
      outcome,
      chain,
      submittedAt,
      approvals,
      rejection,
      anchor,
    });
  }
  if (overrides.length > 0)
    throw new Error('planner: not enough approved claims for the edge values');

  // Claim numbers in creation order: EXP-<IST year of created_at>-<global sequence>.
  const byCreation = [...plans].sort((a, b) => a.createdAt - b.createdAt);
  const numbered = new Map(byCreation.map((p, i) => [p, i + 1]));
  return {
    plans: plans.map((p) => ({
      ...p,
      claimNumber: `EXP-${ymdOf(p.createdAt).slice(0, 4)}-${String(numbered.get(p)).padStart(6, '0')}`,
    })),
    edges: { midnight, lastMs },
    tieAt,
  };
}

// ------------------------------------------------------------------------------- writing

interface EventRow {
  claimId: string;
  submissionId: string;
  stepId: string | null;
  type: 'CLAIM_SUBMITTED' | 'STEP_APPROVED' | 'CLAIM_APPROVED' | 'CLAIM_REJECTED';
  actorId: string;
  totalMinor: number;
  reason: string | null;
  payload: Record<string, unknown>;
  requestId: string;
  occurredAt: number;
}
/** from/to and the actor role follow from the type, as in src/server/audit/record-event.ts. */
const TRANSITION = {
  CLAIM_SUBMITTED: ['DRAFT', 'SUBMITTED', 'CLAIMANT'],
  STEP_APPROVED: ['SUBMITTED', 'SUBMITTED', 'APPROVER'],
  CLAIM_APPROVED: ['SUBMITTED', 'APPROVED', 'APPROVER'],
  CLAIM_REJECTED: ['SUBMITTED', 'REJECTED', 'APPROVER'],
} as const;

/** One INSERT for a batch of events; each one is first validated against C-20's Zod union. */
async function insertEvents(sql: SeedSql, rows: readonly EventRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (const e of rows)
    ClaimEventInputSchema.parse({
      type: e.type,
      claimId: e.claimId,
      submissionId: e.submissionId,
      revision: 1,
      totalMinor: e.totalMinor,
      ...(e.stepId !== null && { stepId: e.stepId }),
      ...(e.reason !== null && { reason: e.reason }),
      payload: e.payload,
    });
  const col = <K extends keyof EventRow>(k: K) => rows.map((r) => r[k]);
  const inserted = await sql`
    INSERT INTO claim_events (claim_id, submission_id, step_id, revision, type, actor_id,
                              actor_role, from_status, to_status, total_minor, reason, payload,
                              request_id, occurred_at)
    SELECT v.claim_id, v.submission_id, v.step_id, 1, v.type::claim_event_type, v.actor_id,
           v.actor_role::event_actor_role, v.from_status::claim_status, v.to_status::claim_status,
           v.total_minor, v.reason, v.payload::jsonb, v.request_id, v.occurred_at
      FROM unnest(${col('claimId')}::uuid[], ${col('submissionId')}::uuid[],
                  ${col('stepId')}::uuid[],
                  ${col('type')}::text[], ${col('actorId')}::uuid[],
                  ${rows.map((r) => TRANSITION[r.type][2])}::text[],
                  ${rows.map((r) => TRANSITION[r.type][0])}::text[],
                  ${rows.map((r) => TRANSITION[r.type][1])}::text[],
                  ${col('totalMinor')}::int[], ${col('reason')}::text[],
                  ${rows.map((r) => JSON.stringify(r.payload))}::text[],
                  ${col('requestId')}::text[],
                  ${rows.map((r) => iso(r.occurredAt))}::timestamptz[])
           AS v(claim_id, submission_id, step_id, type, actor_id, actor_role, from_status,
                to_status, total_minor, reason, payload, request_id, occurred_at)
    RETURNING 1`;
  expectCount('claim_events', inserted.length, rows.length);
}

function expectCount(what: string, got: number, want: number): void {
  if (got !== want) throw new Error(`${what}: wrote ${got} rows, expected ${want}`);
}

/** One month in ONE transaction, in the C-25 write orders; COMMIT runs the deferred checks. */
async function writeMonth(
  client: pg.Client,
  plans: readonly ClaimPlan[],
  categoryIds: ReadonlyMap<string, string>,
): Promise<void> {
  const sql = sqlOf(client);
  await sql`BEGIN`;
  try {
    // 1. Empty DRAFTs; the owner supplies claim_number and created_at.
    const claimRows = await sql`
      INSERT INTO claims (claim_number, claimant_id, title, created_at, updated_at)
      SELECT * FROM unnest(${plans.map((p) => p.claimNumber)}::text[],
                           ${plans.map((p) => p.claimantId)}::uuid[],
                           ${plans.map((p) => p.title)}::text[],
                           ${plans.map((p) => iso(p.createdAt))}::timestamptz[],
                           ${plans.map((p) => iso(p.createdAt))}::timestamptz[])
      RETURNING id, claim_number`;
    expectCount('claims', claimRows.length, plans.length);
    const idOf = new Map(claimRows.map((r) => [r.claim_number as string, r.id as string]));
    const cid = (p: ClaimPlan) => idOf.get(p.claimNumber)!;

    // 2. Every line of the month in ONE INSERT: the statement trigger recomputes each total once.
    const lines = plans.flatMap((p) =>
      p.lines.map((l) => ({ claimId: cid(p), createdAt: p.createdAt, ...l })),
    );
    const lineRows = await sql`
      INSERT INTO line_items (claim_id, category_id, expense_date, amount_minor, description,
                              merchant, created_at, updated_at)
      SELECT v.claim_id, v.category_id, v.expense_date, v.amount_minor, v.description, v.merchant,
             v.created_at, v.created_at
        FROM unnest(${lines.map((l) => l.claimId)}::uuid[],
                    ${lines.map((l) => categoryIds.get(l.category)!)}::uuid[],
                    ${lines.map((l) => l.expenseDate)}::date[],
                    ${lines.map((l) => l.amountMinor)}::int[],
                    ${lines.map((l) => l.description)}::text[],
                    ${lines.map((l) => l.merchant)}::text[],
                    ${lines.map((l) => iso(l.createdAt))}::timestamptz[])
             AS v(claim_id, category_id, expense_date, amount_minor, description, merchant,
                  created_at)
      RETURNING 1`;
    expectCount('line_items', lineRows.length, lines.length);
    const totals = await sql`
      SELECT id, total_minor FROM claims WHERE id = ANY(${[...idOf.values()]}::uuid[])`;
    const totalOf = new Map(totals.map((r) => [r.id as string, Number(r.total_minor)]));
    for (const p of plans)
      if (totalOf.get(cid(p)) !== p.totalMinor)
        throw new Error(
          `${p.claimNumber}: the DB total ${totalOf.get(cid(p))} ≠ planned ${p.totalMinor}`,
        );

    const submitted = plans.filter((p) => p.outcome !== 'DRAFT');
    if (submitted.length > 0) {
      // 3. Snapshots built in SQL from the live rows, ONE statement (07 §12.1);
      //    claim_submissions_verify still checks each one against the locked claim (UC016).
      const subRows = await sql`
        INSERT INTO claim_submissions (claim_id, revision, submitted_by_id, submitted_at,
                                       created_at, total_minor, currency, line_item_count, snapshot)
        SELECT c.id, 1, c.claimant_id, b.submitted_at, b.submitted_at, c.total_minor, c.currency,
               (SELECT count(*) FROM line_items li WHERE li.claim_id = c.id),
               jsonb_build_object('v', 1,
                 'claimant', jsonb_build_object('id', u.id, 'employeeCode', u.employee_code,
                                                'name', u.name, 'email', u.email,
                                                'departmentCode', d.code),
                 'title', c.title, 'currency', c.currency, 'totalMinor', c.total_minor,
                 'lines', (SELECT jsonb_agg(jsonb_build_object(
                             'lineItemId', li.id, 'expenseDate', li.expense_date,
                             'categoryId', k.id, 'categoryCode', k.code, 'categoryName', k.name,
                             'glCode', k.gl_code, 'amountMinor', li.amount_minor,
                             'description', li.description, 'merchant', li.merchant,
                             'receipts', '[]'::jsonb) ORDER BY li.expense_date, li.id)
                             FROM line_items li JOIN categories k ON k.id = li.category_id
                            WHERE li.claim_id = c.id))
          FROM unnest(${submitted.map(cid)}::uuid[],
                      ${submitted.map((p) => iso(p.submittedAt!))}::timestamptz[])
               AS b(claim_id, submitted_at)
          JOIN claims c ON c.id = b.claim_id
          JOIN users u ON u.id = c.claimant_id
          JOIN departments d ON d.id = u.department_id
        RETURNING id, claim_id`;
      expectCount('claim_submissions', subRows.length, submitted.length);
      const subOf = new Map(subRows.map((r) => [r.claim_id as string, r.id as string]));
      const sid = (p: ClaimPlan) => subOf.get(cid(p))!;

      // 4. The chains (level 1 PENDING from submitted_at, the rest WAITING), then the submit.
      const steps = submitted.flatMap((p) => p.chain.map((s) => ({ p, s })));
      const activatedAt = steps.map(({ p, s }) => (s.level === 1 ? iso(p.submittedAt!) : null));
      const stepRows = await sql`
        INSERT INTO approval_steps (claim_id, submission_id, level, tier_code, tier_label,
                                    applies_above_minor, approver_id, resolved_via, status,
                                    activated_at, created_at)
        SELECT v.claim_id, v.submission_id, v.level, v.tier_code, v.tier_label,
               v.applies_above_minor, v.approver_id, v.resolved_via,
               v.status::approval_step_status, v.activated_at, v.created_at
          FROM unnest(${steps.map(({ p }) => cid(p))}::uuid[],
                      ${steps.map(({ p }) => sid(p))}::uuid[],
                      ${steps.map(({ s }) => s.level)}::smallint[],
                      ${steps.map(({ s }) => s.tierCode)}::text[],
                      ${steps.map(({ s }) => s.tierLabel)}::text[],
                      ${steps.map(({ s }) => s.appliesAboveMinor)}::int[],
                      ${steps.map(({ s }) => s.approverId)}::uuid[],
                      ${steps.map(({ s }) => s.resolvedVia)}::text[],
                      ${steps.map(({ s }) => (s.level === 1 ? 'PENDING' : 'WAITING'))}::text[],
                      ${activatedAt}::timestamptz[],
                      ${steps.map(({ p }) => iso(p.submittedAt!))}::timestamptz[])
               AS v(claim_id, submission_id, level, tier_code, tier_label, applies_above_minor,
                    approver_id, resolved_via, status, activated_at, created_at)
        RETURNING id, claim_id, level`;
      expectCount('approval_steps', stepRows.length, steps.length);
      const stepIdOf = new Map(stepRows.map((r) => [`${r.claim_id}:${r.level}`, r.id as string]));
      const stepId = (p: ClaimPlan, level: number) => stepIdOf.get(`${cid(p)}:${level}`)!;
      const approverAt = (p: ClaimPlan, level: number) => p.chain[level - 1]!.approverId;

      const sub = await sql`
        UPDATE claims c
           SET status = 'SUBMITTED', current_revision = 1, current_submission_id = v.submission_id,
               submitted_at = v.at, updated_at = v.at
          FROM unnest(${submitted.map(cid)}::uuid[], ${submitted.map(sid)}::uuid[],
                      ${submitted.map((p) => iso(p.submittedAt!))}::timestamptz[])
               AS v(id, submission_id, at)
         WHERE c.id = v.id AND c.status = 'DRAFT'
        RETURNING 1`;
      expectCount('claims → SUBMITTED', sub.length, submitted.length);
      const requestId = (p: ClaimPlan, n: number) => `perf-${flags.seed}-${p.claimNumber}-${n}`;
      await insertEvents(
        sql,
        submitted.map((p) => ({
          claimId: cid(p),
          submissionId: sid(p),
          stepId: null,
          type: 'CLAIM_SUBMITTED',
          actorId: p.claimantId,
          totalMinor: p.totalMinor,
          reason: null,
          payload: {
            lineItemCount: p.lines.length,
            chain: p.chain.map(({ level, tierCode, approverId, resolvedVia }) => ({
              level,
              tierCode,
              approverId,
              resolvedVia,
            })),
          },
          requestId: requestId(p, 0),
          occurredAt: p.submittedAt!,
        })),
      );

      // 5. Decisions level by level, each a few set-based statements (C-25 order per decision:
      //    step → next step or claim → event). The guards re-check eligibility and the chain.
      const maxLevel = Math.max(...submitted.map((p) => p.chain.length));
      for (let level = 1; level <= maxLevel; level++) {
        const approve = submitted.filter((p) => p.approvals.length >= level);
        const reject = submitted.filter((p) => p.rejection?.level === level);
        const advance = approve.filter((p) => level < p.chain.length);
        const finals = approve.filter((p) => level === p.chain.length);
        const decidedAt = (p: ClaimPlan) => p.approvals[level - 1]!.at;
        const events: EventRow[] = [];

        if (approve.length > 0) {
          const r = await sql`
            UPDATE approval_steps s SET status = 'APPROVED', decided_at = v.at, comment = v.comment
              FROM unnest(${approve.map((p) => stepId(p, level))}::uuid[],
                          ${approve.map((p) => iso(decidedAt(p)))}::timestamptz[],
                          ${approve.map((p) => p.approvals[level - 1]!.comment)}::text[])
                   AS v(id, at, comment)
             WHERE s.id = v.id AND s.status = 'PENDING'
            RETURNING 1`;
          expectCount(`steps L${level} → APPROVED`, r.length, approve.length);
        }
        if (advance.length > 0) {
          const r = await sql`
            UPDATE approval_steps s SET status = 'PENDING', activated_at = v.at
              FROM unnest(${advance.map((p) => stepId(p, level + 1))}::uuid[],
                          ${advance.map((p) => iso(decidedAt(p)))}::timestamptz[]) AS v(id, at)
             WHERE s.id = v.id AND s.status = 'WAITING'
            RETURNING 1`;
          expectCount(`steps L${level + 1} → PENDING`, r.length, advance.length);
          for (const p of advance)
            events.push({
              claimId: cid(p),
              submissionId: sid(p),
              stepId: stepId(p, level),
              type: 'STEP_APPROVED',
              actorId: approverAt(p, level),
              totalMinor: p.totalMinor,
              reason: p.approvals[level - 1]!.comment,
              payload: {
                level,
                levelCount: p.chain.length,
                tierCode: p.chain[level - 1]!.tierCode,
                nextApproverId: approverAt(p, level + 1),
              },
              requestId: requestId(p, level),
              occurredAt: decidedAt(p),
            });
        }
        if (finals.length > 0) {
          const r = await sql`
            UPDATE claims c SET status = 'APPROVED', approved_at = v.at, updated_at = v.at
              FROM unnest(${finals.map(cid)}::uuid[],
                          ${finals.map((p) => iso(decidedAt(p)))}::timestamptz[]) AS v(id, at)
             WHERE c.id = v.id AND c.status = 'SUBMITTED'
            RETURNING 1`;
          expectCount('claims → APPROVED', r.length, finals.length);
          for (const p of finals)
            events.push({
              claimId: cid(p),
              submissionId: sid(p),
              stepId: stepId(p, level),
              type: 'CLAIM_APPROVED',
              actorId: approverAt(p, level),
              totalMinor: p.totalMinor,
              reason: p.approvals[level - 1]!.comment,
              payload: {
                level,
                levelCount: p.chain.length,
                tierCode: p.chain[level - 1]!.tierCode,
                approverIds: p.chain.map((s) => s.approverId),
              },
              requestId: requestId(p, level),
              occurredAt: decidedAt(p),
            });
        }
        if (reject.length > 0) {
          const r = await sql`
            UPDATE approval_steps s
               SET status = 'REJECTED', decided_at = v.at, rejection_reason = v.reason
              FROM unnest(${reject.map((p) => stepId(p, level))}::uuid[],
                          ${reject.map((p) => iso(p.rejection!.at))}::timestamptz[],
                          ${reject.map((p) => p.rejection!.reason)}::text[]) AS v(id, at, reason)
             WHERE s.id = v.id AND s.status = 'PENDING'
            RETURNING 1`;
          expectCount(`steps L${level} → REJECTED`, r.length, reject.length);
          const cancelled = await sql`
            UPDATE approval_steps s SET status = 'CANCELLED', cancelled_at = v.at
              FROM unnest(${reject.map(sid)}::uuid[],
                          ${reject.map((p) => iso(p.rejection!.at))}::timestamptz[])
                   AS v(submission_id, at)
             WHERE s.submission_id = v.submission_id AND s.status = 'WAITING'
            RETURNING s.id, s.claim_id, s.level`;
          expectCount(
            'later steps → CANCELLED',
            cancelled.length,
            reject.reduce((n, p) => n + p.chain.length - level, 0),
          );
          const rc = await sql`
            UPDATE claims c SET status = 'REJECTED', rejected_at = v.at, updated_at = v.at
              FROM unnest(${reject.map(cid)}::uuid[],
                          ${reject.map((p) => iso(p.rejection!.at))}::timestamptz[]) AS v(id, at)
             WHERE c.id = v.id AND c.status = 'SUBMITTED'
            RETURNING 1`;
          expectCount('claims → REJECTED', rc.length, reject.length);
          for (const p of reject)
            events.push({
              claimId: cid(p),
              submissionId: sid(p),
              stepId: stepId(p, level),
              type: 'CLAIM_REJECTED',
              actorId: approverAt(p, level),
              totalMinor: p.totalMinor,
              reason: p.rejection!.reason,
              payload: {
                level,
                levelCount: p.chain.length,
                tierCode: p.chain[level - 1]!.tierCode,
                cancelledStepIds: cancelled
                  .filter((c) => c.claim_id === cid(p))
                  .sort((a, b) => Number(a.level) - Number(b.level))
                  .map((c) => c.id as string),
              },
              requestId: requestId(p, level),
              occurredAt: p.rejection!.at,
            });
        }
        await insertEvents(sql, events);
      }
    }
    await sql`COMMIT`; // UC009 (totals) and UC015 (audit) run here, over this month's rows
  } catch (err) {
    await sql`ROLLBACK`.catch(() => {});
    throw err;
  }
}

// ------------------------------------------------------------------------------------ main

const timings: [string, number][] = [];
let lapStart = performance.now();
const t0 = lapStart;
const lap = (label: string) => {
  const now = performance.now();
  timings.push([label, (now - lapStart) / 1000]);
  lapStart = now;
};
const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function withClient<T>(url: URL, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url.href, application_name: 'expense-perf-seed' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let exitCode = 0;
try {
  const w = windowOf(flags);
  log(`${flagLine} → ${w.months[0]}-01 … ${flags.until} 00:00 ${BUSINESS_TIMEZONE}, db ${perfDb}`);

  // 1. A fresh database with the production privileges (01-roles.sh's database part, 03 §16.1).
  const db = quoteIdent(perfDb);
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${db} OWNER expense_owner`);
    await c.query(`ALTER DATABASE ${db} SET timezone TO 'UTC'`);
    await c.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`); // no CONNECT/TEMPORARY for PUBLIC
    await c.query(`GRANT CONNECT ON DATABASE ${db} TO expense_app`);
  });
  await withClient(perfUrl, async (c) => {
    await c.query('ALTER SCHEMA public OWNER TO expense_owner');
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await c.query('GRANT USAGE ON SCHEMA public TO expense_app');
  });
  log(`created ${perfDb} (owner expense_owner) with the 01-roles.sh database privileges`);
  lap('create database');

  // `prisma migrate deploy` against expense_perf only: prisma.config.ts reads MIGRATE_DATABASE_URL,
  // and @next/env never overrides a variable that is already set.
  const prismaBin = resolve('node_modules/.bin/prisma');
  const migrate = spawnSync(prismaBin, ['migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, MIGRATE_DATABASE_URL: perfUrl.href, DATABASE_URL: perfUrl.href },
  });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy exited ${migrate.status}`);
  lap('prisma migrate deploy');

  const client = new pg.Client({
    connectionString: perfUrl.href,
    application_name: 'expense-perf-seed',
  });
  await client.connect();
  try {
    const sql = sqlOf(client);
    const [{ current_user: whoami, current_database: whereami } = {}] = await sql`
      SELECT current_user, current_database()`;
    if (whoami !== 'expense_owner' || whereami !== perfDb)
      throw new Error(`connected as ${String(whoami)} to ${String(whereami)}, not owner@${perfDb}`);

    // 2. Reference data (the demo's), the 500-person org and the tiers, in one transaction.
    const hash = await hashPassword(demoPassword); // ONE argon2id hash, shared by every perf user
    const waves = buildOrg();
    await sql`BEGIN`;
    await seedReference(sql); // departments, categories, L1–L3 (L4 needs its designated user)
    await sql`
      INSERT INTO departments (code, name)
      SELECT * FROM unnest(${PERF_DEPARTMENTS.map((d) => d.code)}::text[],
                           ${PERF_DEPARTMENTS.map((d) => d.name)}::text[])
      ON CONFLICT (code) DO NOTHING`;
    for (const wave of waves) {
      const rows = await sql`
        INSERT INTO users (employee_code, email, name, role, can_approve, is_fallback_approver,
                           department_id, manager_id, password_hash)
        SELECT v.code, v.email, v.name, v.role::user_role, v.can_approve, v.fallback, d.id, m.id,
               ${hash}
          FROM unnest(${wave.map((p) => p.code)}::text[], ${wave.map((p) => p.email)}::text[],
                      ${wave.map((p) => p.name)}::text[], ${wave.map((p) => p.role)}::text[],
                      ${wave.map((p) => p.canApprove)}::boolean[],
                      ${wave.map((p) => p.fallback)}::boolean[], ${wave.map((p) => p.dept)}::text[],
                      ${wave.map((p) => p.manager)}::text[])
               AS v(code, email, name, role, can_approve, fallback, dept, manager_email)
          JOIN departments d ON d.code = v.dept
          LEFT JOIN users m ON m.email = v.manager_email
        RETURNING 1`;
      expectCount('users', rows.length, wave.length);
    }
    // T4 (L4_CFO) inactive, as in the demo, designated to the perf CFO.
    await sql`
      INSERT INTO approval_policy_tiers (level, code, label, applies_above_minor, resolver,
                                         designated_user_id, is_active)
      SELECT ${L4_TIER.level}, ${L4_TIER.code}, ${L4_TIER.label}, ${L4_TIER.appliesAboveMinor},
             'DESIGNATED_USER', u.id, false
        FROM users u WHERE u.email = 'cfo@perf.test'
      ON CONFLICT (code) DO NOTHING`;
    const tiers = await readTiers(sql);
    assertPolicyWellFormed(tiers);
    await sql`COMMIT`;
    const people = waves.flat();
    log(
      `reference data + ${people.length} @perf.test users (one argon2id hash), ${tiers.length} tiers`,
    );
    lap('reference data + users');

    // 3. Plan every claim with the real router, then write one transaction per month.
    const userRows = await sql`
      SELECT id, email, manager_id AS "managerId", is_active AS "isActive",
             can_approve AS "canApprove", role::text AS role,
             is_fallback_approver AS "isFallbackApprover"
        FROM users`;
    const org = buildOrgLookup(userRows as unknown as RoutingRow[]);
    const idByEmail = new Map(userRows.map((r) => [r.email as string, r.id as string]));
    const idsOf = (kind: Kind) =>
      people.filter((p) => p.kind === kind).map((p) => idByEmail.get(p.email)!);
    const categoryIds = new Map(
      (await sql`SELECT code, id FROM categories WHERE is_active`).map((r) => [
        r.code as string,
        r.id as string,
      ]),
    );
    const { plans, edges, tieAt } = planClaims(flags, w, idsOf('ic'), idsOf('manager'), tiers, org);
    lap('plan (buildChain)');

    const byMonth = new Map<string, ClaimPlan[]>();
    for (const p of plans) {
      const m = ymdOf(p.anchor).slice(0, 7);
      const bucket = byMonth.get(m);
      if (bucket) bucket.push(p);
      else byMonth.set(m, [p]);
    }
    const months = [...byMonth.keys()].sort();
    for (const m of months) {
      const t = performance.now();
      const monthPlans = byMonth.get(m)!;
      await writeMonth(client, monthPlans, categoryIds);
      log(
        `${m}: ${monthPlans.length} claims committed in ${((performance.now() - t) / 1000).toFixed(1)} s`,
      );
    }
    lap(`claims (${months.length} monthly transactions)`);

    // 4. Finish: the sequence past every number used, statistics, and the drift check.
    await sql`SELECT setval('public.claim_number_seq', ${plans.length})`;
    await client.query('VACUUM (ANALYZE)');
    lap('VACUUM (ANALYZE)');
    const [drift] = await sql`SELECT count(*)::int AS n FROM v_claim_total_drift`;
    if (drift?.n !== 0) throw new Error(`v_claim_total_drift has ${drift?.n} rows`);

    // 5. docs/perf/seed-summary.txt
    const [version] = await sql`SELECT version() AS v`;
    const statusRows = await sql`
      SELECT status::text AS status, count(*)::int AS n FROM claims GROUP BY 1 ORDER BY 1`;
    const tableRows: { table: string; n: number }[] = [];
    for (const table of SUMMARY_TABLES) {
      const r = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
      tableRows.push({ table, n: r.rows[0]?.n ?? 0 });
    }
    const stepRows = await sql`
      SELECT status::text AS status, count(*)::int AS n FROM approval_steps GROUP BY 1 ORDER BY 1`;
    const levelRows = await sql`
      SELECT n_steps AS levels, count(*)::int AS n
        FROM (SELECT count(*) AS n_steps FROM approval_steps GROUP BY submission_id) s
       GROUP BY 1 ORDER BY 1`;
    const [busiest] = await sql`
      SELECT u.email, count(*)::int AS n
        FROM approval_steps s JOIN users u ON u.id = s.approver_id
       WHERE s.status = 'PENDING' GROUP BY u.email ORDER BY 2 DESC, 1 LIMIT 1`;
    const [ties] = await sql`
      SELECT count(*)::int AS n FROM claims WHERE approved_at = ${iso(tieAt)}::timestamptz`;
    const [edgeRows] = await sql`
      SELECT count(*) FILTER (WHERE t = '00:00:00')::int AS midnight,
             count(*) FILTER (WHERE t = '23:59:59.999')::int AS last_ms
        FROM (SELECT (approved_at AT TIME ZONE 'Asia/Kolkata')::time AS t
                FROM claims WHERE approved_at IS NOT NULL) a`;
    const [acl] = await sql`
      SELECT datacl::text AS datacl,
             (SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public') AS nspacl
        FROM pg_database WHERE datname = current_database()`;
    const submittedPlans = plans.filter((p) => p.outcome !== 'DRAFT');
    const band = (lo: number, hi: number) =>
      submittedPlans.filter((p) => p.totalMinor > lo && p.totalMinor <= hi).length;
    const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`;
    const perMonth = months.map((m) => byMonth.get(m)!.length);
    const recentInFlight = plans.filter(
      (p) => p.outcome === 'SUBMITTED' && p.anchor >= w.end - RECENT_DAYS * 24 * HOUR,
    ).length;
    const lineCount = plans.reduce((n, p) => n + p.lines.length, 0);
    const elapsed = (performance.now() - t0) / 1000;
    const nSub = submittedPlans.length;
    const status = (r: Record<string, unknown>) =>
      `  ${String(r.status).padEnd(10)} ${String(r.n).padStart(7)}  ${pct(Number(r.n), plans.length)}`;
    const summary = [
      `# docs/perf/seed-summary.txt, written by pnpm perf:seed (scripts/perf/seed-perf.ts, 07 §12.1)`,
      `generated:   ${new Date().toISOString()}`,
      `flags:       ${flagLine}`,
      `window:      ${w.months[0]}-01 00:00 IST … ${flags.until} 00:00 IST (${w.months.length} months)`,
      `database:    ${perfDb} as expense_owner, all triggers on; ${String(version?.v)}`,
      `privileges:  datacl ${String(acl?.datacl)}; schema public ${String(acl?.nspacl)}`,
      `elapsed:     ${elapsed.toFixed(1)} s total`,
      ...timings.map(([k, sec]) => `  ${k.padEnd(36)} ${sec.toFixed(1)} s`),
      '',
      `claims by status (target 87% APPROVED, 5% REJECTED, 4% SUBMITTED, 4% DRAFT):`,
      ...statusRows.map(status),
      `  SUBMITTED whose pending level activated in the last ${RECENT_DAYS} days: ${recentInFlight}`,
      '',
      `rows per table:`,
      ...tableRows.map((r) => `  ${r.table.padEnd(22)} ${String(r.n).padStart(8)}`),
      '',
      `transactions: ${months.length}, one per IST month of the claim's final state; claims per ` +
        `month min ${Math.min(...perMonth)} / avg ${Math.round(plans.length / months.length)} / ` +
        `max ${Math.max(...perMonth)}`,
      `lines per claim: mean ${(lineCount / plans.length).toFixed(2)} (1–8)`,
      `submitted totals (target ~72% / ~23% / ~5%): ${pct(band(0, 1_000_000), nSub)} ≤ ₹10,000; ` +
        `${pct(band(1_000_000, 5_000_000), nSub)} ₹10,000–50,000; ` +
        `${pct(band(5_000_000, Infinity), nSub)} > ₹50,000`,
      `chain length per submission: ` +
        levelRows.map((r) => `${String(r.levels)} level(s) ${String(r.n)}`).join(', '),
      `approval_steps by status: ${stepRows.map((r) => `${r.status} ${r.n}`).join(', ')}`,
      `busiest PENDING approver: ${String(busiest?.email)} (${String(busiest?.n)} PENDING steps)`,
      `edge values: ${edgeRows?.midnight} claims approved at exactly 00:00:00.000 IST ` +
        `(planned ${edges.midnight}), ${edgeRows?.last_ms} at 23:59:59.999 IST ` +
        `(planned ${edges.lastMs}); ${ties?.n} claims share approved_at ${iso(tieAt)} ` +
        `(${ymdOf(tieAt)} 11:00 IST)`,
      `org: 1 CFO/fallback, ${ORG.directors} directors, ${ORG.heads} heads, ${ORG.managers} ` +
        `managers (mgr001…), ${ORG.ics} ICs, ${ORG.finance} finance (fin1…), 1 admin; ` +
        `claimants: ICs (90%) and managers (10%)`,
      `claim_number_seq: setval ${plans.length} (app-created claims number after the perf ones)`,
      `integrity: v_claim_total_drift = 0 rows; every month COMMITted through the deferred ` +
        `UC009/UC015 checks`,
      '',
    ].join('\n');
    mkdirSync(dirname(SUMMARY_FILE), { recursive: true });
    writeFileSync(SUMMARY_FILE, summary);
    console.log(summary);
    log(`done in ${elapsed.toFixed(1)} s; wrote ${SUMMARY_FILE}`);
  } finally {
    await client.end().catch(() => {});
  }
} catch (err) {
  console.error(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
}
process.exit(exitCode);
