// TC-U02 (§3.6 period, §6-6): business days are Asia/Kolkata days whatever zone the process or
// browser runs in. Ranges are half-open in UTC (06 §4, 04 §8.4).
import { afterEach, describe, expect, it } from 'vitest';
import {
  businessDateOf,
  businessDayRangeToUtc,
  businessMidnightUtc,
  formatBusinessIso,
  formatCalendarDate,
  formatInstant,
  isValidYmd,
  todayInBusinessTz,
} from '@/shared/dates';
import { ExpenseDateSchema } from '@/shared/schemas/claims';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('TC-U02 dates', () => {
  it("businessDayRangeToUtc('2026-09-01','2026-09-30') is [2026-08-31T18:30:00.000Z, 2026-09-30T18:30:00.000Z)", () => {
    const { gte, lt } = businessDayRangeToUtc('2026-09-01', '2026-09-30');
    expect(gte?.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(lt?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    // September + October = September–October: the ranges abut, so nothing is counted twice
    expect(businessDayRangeToUtc('2026-10-01', '2026-10-31').gte).toEqual(lt);
    // open-ended list filters
    expect(businessDayRangeToUtc('2026-09-01')).toEqual({ gte, lt: undefined });
    expect(businessDayRangeToUtc(undefined, '2026-09-30')).toEqual({ gte: undefined, lt });
    // a leap day and a year end
    expect(businessMidnightUtc('2028-02-29').toISOString()).toBe('2028-02-28T18:30:00.000Z');
    expect(businessDayRangeToUtc('2026-12-31', '2026-12-31').lt?.toISOString()).toBe(
      '2026-12-31T18:30:00.000Z',
    );
  });

  it('rejects impossible dates like 2026-02-30', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-04-31',
      '2027-02-29',
      '30/09/2026',
      '2026-9-1',
    ])
      expect([bad, isValidYmd(bad)]).toEqual([bad, false]);
    expect(isValidYmd('2028-02-29')).toBe(true);
    expect(() => businessDayRangeToUtc('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => formatCalendarDate('2026-13-01')).toThrow(RangeError);
    for (const bad of ['2026-02-30', '2026-13-01', '30/09/2026'])
      expect([bad, ExpenseDateSchema.safeParse(bad).error?.issues.map((i) => i.message)]).toEqual([
        bad,
        ['Use a real date in YYYY-MM-DD form'], // one honest issue, never also "in the future"
      ]);
  });

  it('todayInBusinessTz at 2026-09-30T18:30:00.000Z is 2026-10-01', () => {
    expect(todayInBusinessTz(new Date('2026-09-30T18:30:00.000Z'))).toBe('2026-10-01');
    expect(todayInBusinessTz(new Date('2026-09-30T18:29:59.999Z'))).toBe('2026-09-30');
    process.env.TZ = 'America/Los_Angeles'; // still Sep 30 there, but already Oct 1 in IST
    expect(todayInBusinessTz(new Date('2026-09-30T18:30:00.000Z'))).toBe('2026-10-01');
  });

  it('formats instants in Asia/Kolkata regardless of process TZ', () => {
    const at = new Date('2026-09-30T18:45:00.000Z'); // 00:15 on 1 Oct in IST
    const render = () => ({
      instant: formatInstant(at.toISOString()),
      iso: formatBusinessIso(at),
      day: businessDateOf(at),
      calendar: formatCalendarDate('2026-10-05'),
      range: businessDayRangeToUtc('2026-09-01', '2026-09-30').gte?.toISOString(),
    });
    const seen = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata'].map((tz) => {
      process.env.TZ = tz;
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(
        { UTC: 0, 'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840, 'Asia/Kolkata': -330 }[
          tz
        ],
      ); // the process zone really changed
      return render();
    });
    for (const s of seen) expect(s).toEqual(seen[0]);
    expect(seen[0]).toEqual({
      instant: expect.stringMatching(/^1 Oct 2026, 12:15\s?am IST$/i),
      iso: '2026-10-01T00:15:00.000+05:30',
      day: '2026-10-01',
      calendar: '5 Oct 2026',
      range: '2026-08-31T18:30:00.000Z',
    });
  });
});
