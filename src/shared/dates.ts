import { BUSINESS_TIMEZONE, EXPORT_SETTLE_MINUTES } from '@/shared/policy';

// 06 §4 + 05 §13 (D-10). Business days are Asia/Kolkata days. Intl only: no date library and no
// hard-coded +05:30 arithmetic. Calendar dates travel as 'YYYY-MM-DD'; instants as UTC ISO with Z.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, 30/09/2026). */
export function isValidYmd(s: string): boolean {
  const m = YMD.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const partsOf = (ymd: string): [number, number, number] => {
  const [y = NaN, m = NaN, d = NaN] = ymd.split('-').map(Number);
  return [y, m, d];
};

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = partsOf(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Calendar days from `from` to `to`, both included: ('2028-01-01', '2028-12-31') → 366,
 * ('2026-09-01', '2026-09-01') → 1. NaN unless both are real YYYY-MM-DD dates.
 */
export function inclusiveDays(from: string, to: string): number {
  if (!isValidYmd(from) || !isValidYmd(to)) return NaN;
  const [fy, fm, fd] = partsOf(from);
  const [ty, tm, td] = partsOf(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The business zone's UTC offset at an instant (+19_800_000 for IST). */
function zoneOffsetMs(at: Date): number {
  const p = Object.fromEntries(wallClock.formatToParts(at).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - (at.getTime() - at.getUTCMilliseconds());
}

/** 00:00 in the business zone on `ymd`, as a UTC instant. Two passes: DST-safe in any zone. */
export function businessMidnightUtc(ymd: string): Date {
  const [y, m, d] = partsOf(ymd);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - zoneOffsetMs(new Date(wall));
  return new Date(wall - zoneOffsetMs(new Date(first)));
}

/**
 * Inclusive business dates → the half-open UTC range [from 00:00, (to + 1) 00:00), so September
 * plus October equals September–October with no duplicates. Either bound may be omitted (lists).
 */
export function businessDayRangeToUtc(from?: string, to?: string): { gte?: Date; lt?: Date } {
  for (const d of [from, to])
    if (d !== undefined && !isValidYmd(d)) throw new RangeError(`Bad date: ${d}`);
  return {
    gte: from ? businessMidnightUtc(from) : undefined,
    lt: to ? businessMidnightUtc(addDaysYmd(to, 1)) : undefined,
  };
}

/**
 * The export's settle window (06 §6.2, D-32): a period is still "open" until EXPORT_SETTLE_MINUTES
 * after it ends, i.e. while `(to + 1) 00:00 IST + 2 min > asOf`. `approved_at = now()` is the
 * approving transaction's START, so a final approval begun at 23:59:59.9 on the last day commits
 * just after midnight; two minutes is far longer than any transaction may live (10 s / 15 s), so
 * once the window has passed every approval of the period has committed or rolled back.
 */
export function isExportPeriodOpen(to: string, asOf: Date): boolean {
  const end = businessMidnightUtc(addDaysYmd(to, 1)).getTime();
  return end + EXPORT_SETTLE_MINUTES * 60_000 > asOf.getTime();
}

const ymdFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The business date an instant falls on: 2026-09-30T18:30:00.000Z → "2026-10-01". */
export const businessDateOf = (at: Date): string => ymdFmt.format(at);

/** "Today" as an IST calendar date, even on a server running in UTC. Evaluate per call. */
export const todayInBusinessTz = (now: Date = new Date()): string => businessDateOf(now);

/** "2026-09-15T16:42:10.000+05:30" (CSV export columns). */
export function formatBusinessIso(at: Date): string {
  const off = zoneOffsetMs(at);
  const abs = Math.abs(off) / 60_000;
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${new Date(at.getTime() + off).toISOString().slice(0, 23)}${off < 0 ? '-' : '+'}${hhmm}`;
}

// A Postgres `date` reaches JS as a Date at UTC midnight (Prisma) and goes back the same way.

/** Prisma `@db.Date` value → "YYYY-MM-DD". */
export const ymdOfDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** "YYYY-MM-DD" → the Date Prisma writes to a `@db.Date` column. */
export const dateOnlyOfYmd = (ymd: string): Date => new Date(`${ymd}T00:00:00.000Z`);

// ------------------------------------------------------------------------------------- display

const ist = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: BUSINESS_TIMEZONE, ...o });
const instantFmt = ist({
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** An instant shown in IST with a literal suffix: "1 Oct 2026, 12:15 am IST". */
export const formatInstant = (iso: string): string => `${instantFmt.format(new Date(iso))} IST`;

const calendarFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "2026-10-05" → "5 Oct 2026" from its own parts, so the browser's zone can't shift it. */
export function formatCalendarDate(ymd: string): string {
  if (!isValidYmd(ymd)) throw new RangeError(`Bad date: ${ymd}`);
  const [y, m, d] = partsOf(ymd);
  return calendarFmt.format(new Date(Date.UTC(y, m - 1, d)));
}

/** The calendar month containing `todayYmd`, shifted by `offsetMonths` (export presets). */
export function monthPeriod(todayYmd: string, offsetMonths = 0): { from: string; to: string } {
  const [y, mo] = partsOf(todayYmd);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(y, mo - 1 + offsetMonths, 1))),
    to: iso(new Date(Date.UTC(y, mo + offsetMonths, 0))),
  };
}
