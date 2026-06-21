/**
 * US federal holiday calendar.
 *
 * Business-hour / SLA / past-due math must not count federal US holidays as
 * elapsed work time. Driver: 2026-06-19 was Juneteenth (a Friday federal
 * holiday) — an order placed that day showed "41h old" by Saturday and got
 * flagged as past the delivery threshold, even though zero business time had
 * elapsed. This module is the holiday CALENDAR; the 7am–7pm business-window
 * math that consumes it lives in lib/expert-sla.ts (the single source of truth
 * for business-hours elapsed, now holiday-aware).
 *
 * Holidays follow OPM observance rules: a holiday on a Saturday is observed the
 * preceding Friday; on a Sunday, the following Monday.
 */

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Nth occurrence (1-based) of a weekday (0=Sun..6=Sat) in a month (1-12). */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    if (dt.getUTCMonth() !== month - 1) break;
    if (dt.getUTCDay() === weekday && ++count === n) return ymd(year, month, d);
  }
  return ymd(year, month, 1); // unreachable for valid inputs
}

/** Last occurrence of a weekday in a month. */
function lastWeekday(year: number, month: number, weekday: number): string {
  let last = ymd(year, month, 1);
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    if (dt.getUTCMonth() !== month - 1) break;
    if (dt.getUTCDay() === weekday) last = ymd(year, month, d);
  }
  return last;
}

/** Observed date for a fixed-date holiday: Sat → preceding Fri, Sun → next Mon. */
function observed(year: number, month: number, day: number): string {
  const dt = new Date(Date.UTC(year, month - 1, day));
  const dow = dt.getUTCDay();
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  else if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

const holidayCache = new Map<number, Set<string>>();

/** Set of YYYY-MM-DD observed federal holidays for a calendar year. */
export function federalHolidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const set = new Set<string>([
    // Fixed-date (observance-shifted)
    observed(year, 1, 1),    // New Year's Day
    observed(year, 6, 19),   // Juneteenth National Independence Day
    observed(year, 7, 4),    // Independence Day
    observed(year, 11, 11),  // Veterans Day
    observed(year, 12, 25),  // Christmas Day
    // Floating Mondays/Thursday (always weekdays — no shift)
    nthWeekday(year, 1, 1, 3),   // MLK Jr. Day — 3rd Mon Jan
    nthWeekday(year, 2, 1, 3),   // Washington's Birthday — 3rd Mon Feb
    lastWeekday(year, 5, 1),     // Memorial Day — last Mon May
    nthWeekday(year, 9, 1, 1),   // Labor Day — 1st Mon Sep
    nthWeekday(year, 10, 1, 2),  // Columbus Day — 2nd Mon Oct
    nthWeekday(year, 11, 4, 4),  // Thanksgiving — 4th Thu Nov
    // Next year's New Year may be observed on Dec 31 of this year (Jan 1 = Sat).
    observed(year + 1, 1, 1),
  ]);
  holidayCache.set(year, set);
  return set;
}

/** True if the given YYYY-MM-DD is an observed federal holiday. */
export function isFederalHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4), 10);
  return federalHolidaysForYear(year).has(dateStr);
}

/** True if YYYY-MM-DD is a business day (Mon–Fri and not a federal holiday). */
export function isBusinessDay(dateStr: string): boolean {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isFederalHoliday(dateStr);
}

// ── calendar business-DAY elapsed ─────────────────────────────────────────
// Distinct from expert-sla's businessHoursElapsed (which counts the 7am–7pm
// work window). This counts full wall-clock time on business days, expressed
// in DAYS — for "stall"/"days-pending" flags whose thresholds are calendar
// days (e.g. "stuck 2 days", "unsigned 5 days") but which must not count
// weekends or federal holidays toward the total.

const DAY_TZ = 'America/New_York';

/** YYYY-MM-DD that `tz` considers the date at instant `ms`. */
function isoDateInTz(ms: number, tz: string): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
}

/** UTC epoch-ms of 00:00 (midnight) in `tz` on the given YYYY-MM-DD. */
function tzMidnightMs(dateStr: string, tz: string): number {
  const probe = new Date(`${dateStr}T00:00:00Z`);
  const tzHour = Number(
    probe.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false, hourCycle: 'h23' }),
  );
  return probe.getTime() + ((24 - tzHour) % 24) * 3_600_000;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Business days elapsed between two instants — counts full wall-clock time on
 * Mon–Fri non-holiday days, divided by 24h. Weekend + holiday spans contribute
 * zero. Use for calendar-day "stall"/"days-pending" thresholds (a value of
 * 2.0 ≈ two business days have passed).
 */
export function businessDaysElapsed(startMs: number, endMs: number, tz: string = DAY_TZ): number {
  if (!(endMs > startMs)) return 0;
  let totalMs = 0;
  let cur = startMs;
  let guard = 0;
  while (cur < endMs && guard++ < 4000) {
    const dateStr = isoDateInTz(cur, tz);
    const nextMidnight = tzMidnightMs(addDays(dateStr, 1), tz);
    const segEnd = Math.min(endMs, nextMidnight);
    if (isBusinessDay(dateStr) && segEnd > cur) totalMs += segEnd - cur;
    cur = nextMidnight;
  }
  return totalMs / 86_400_000;
}
