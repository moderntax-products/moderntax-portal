/**
 * Expert SLA Clock
 *
 * Single source of truth for the "how long has the expert had this
 * assignment" calculation. Every dashboard, cron, and email that talks
 * about overdue/elapsed/turnaround for experts MUST route through this
 * module.
 *
 * Rules (source: matt 2026-04-27):
 *   1. Clock starts at expert_clock_started_at (the timestamp the 8821
 *      was signed AND verified to carry the assigned expert's credentials
 *      — CAF, name, address, PTIN, phone). Null = not yet running.
 *   2. Saturday + Sunday do NOT count.
 *   3. Time before 7am or at/after 7pm in the EXPERT'S local wall clock
 *      does NOT count. So weekday usable window = [07:00, 19:00) local.
 *      DST-aware: the wall clock follows whatever timezone is current
 *      (Pacific expert in April uses PDT, in January uses PST).
 *
 * Concretely: a 24-hour SLA = 12 hours/day × 2 weekdays. An 8821
 * verified Friday at 17:00 local has 2 hours of budget that day, then
 * the next 12 hours run Monday 07:00–19:00.
 *
 * Implementation strategy: walk forward from the start one ms-block
 * per day, intersecting each day's [07:00, 19:00) window in the expert
 * tz with [start, end] in absolute time, summing the overlaps. Slow if
 * the spans are huge (>1 year), fine for our scale (max ~weeks).
 */

const DEFAULT_EXPERT_TZ = 'America/Los_Angeles';
const BUSINESS_HOUR_START = 7;   // 07:00 local
const BUSINESS_HOUR_END = 19;    // 19:00 local (exclusive)
const MS_PER_HOUR = 3_600_000;

/**
 * Returns the wall-clock parts (year/month/day/hour/minute/weekday) of
 * a UTC instant interpreted in the given IANA timezone. Uses
 * Intl.DateTimeFormat which is DST-aware.
 */
function partsInTz(date: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; // 0=Sun..6=Sat
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hourStr = get('hour');
  // Intl returns "24" instead of "00" sometimes for midnight
  const hour = hourStr === '24' ? 0 : parseInt(hourStr, 10);
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

/**
 * Returns the UTC ms timestamp corresponding to the given wall-clock
 * date+time in the given timezone. Iterative because IANA + DST means
 * there's no closed-form solution — we converge in 2-3 steps.
 */
function tzWallClockToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string,
): number {
  // Initial guess: treat the wall-clock as UTC
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  // Refine twice — accounts for DST + offset shifts
  for (let i = 0; i < 3; i++) {
    const parts = partsInTz(new Date(guess), tz);
    const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const targetMs = Date.UTC(year, month - 1, day, hour, minute);
    const drift = wallMs - targetMs;
    if (drift === 0) return guess;
    guess -= drift;
  }
  return guess;
}

/**
 * Convert a naive wall-clock date + time in the given IANA timezone to a UTC
 * Date. DST-aware. Use this instead of `new Date("YYYY-MM-DDTHH:MM:00")`, which
 * silently interprets the string as the SERVER's local time (UTC on Vercel) and
 * produces the wrong instant for any non-UTC timezone — the root cause of
 * experts missing IRS PPS callbacks (MOD-204).
 *
 * @param dateStr "YYYY-MM-DD"
 * @param timeStr "HH:MM" (24h)
 * @param tz      IANA zone, e.g. "America/Los_Angeles"
 */
export function zonedWallClockToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if ([y, mo, d, h, mi].some(n => Number.isNaN(n))) {
    throw new Error(`zonedWallClockToUtc: invalid date/time "${dateStr}T${timeStr}"`);
  }
  return new Date(tzWallClockToUtcMs(y, mo, d, h, mi, tz));
}

/**
 * For a given absolute instant + tz, return the [windowStart, windowEnd]
 * UTC ms that bracket the *same calendar day's* [7am, 7pm) local window.
 * Returns null if that day is Sat or Sun.
 */
function businessWindowForDay(instantMs: number, tz: string): { start: number; end: number } | null {
  const parts = partsInTz(new Date(instantMs), tz);
  if (parts.weekday === 0 || parts.weekday === 6) return null; // Sun/Sat
  const start = tzWallClockToUtcMs(parts.year, parts.month, parts.day, BUSINESS_HOUR_START, 0, tz);
  const end = tzWallClockToUtcMs(parts.year, parts.month, parts.day, BUSINESS_HOUR_END, 0, tz);
  return { start, end };
}

/**
 * Move forward one local calendar day from the given instant in the
 * given tz, returning the UTC ms for 00:00 (midnight) of the NEXT
 * local calendar day. Date.UTC() naturally handles month/year rollover
 * (e.g., day 31 of April rolls to May 1), so we just bump day+1 and
 * let tzWallClockToUtcMs converge on the right UTC instant.
 */
function nextLocalMidnight(instantMs: number, tz: string): number {
  const parts = partsInTz(new Date(instantMs), tz);
  return tzWallClockToUtcMs(parts.year, parts.month, parts.day + 1, 0, 0, tz);
}

/**
 * Compute the number of business hours elapsed between `startMs` and
 * `endMs`, intersecting [start, end] with each day's [7am, 7pm) window
 * in the expert's tz, skipping weekends.
 *
 * Returns 0 if startMs >= endMs or if startMs is null/undefined.
 */
export function businessHoursElapsed(
  startMs: number | null | undefined,
  endMs: number,
  expertTz: string = DEFAULT_EXPERT_TZ,
): number {
  if (!startMs || endMs <= startMs) return 0;

  let totalMs = 0;
  let cursor = startMs;
  // Hard cap iterations to ~5 years of days for safety
  const MAX_ITERATIONS = 365 * 5;
  let iterations = 0;

  while (cursor < endMs && iterations < MAX_ITERATIONS) {
    iterations++;
    const window = businessWindowForDay(cursor, expertTz);
    if (window) {
      // Intersect [cursor, endMs] with [window.start, window.end]
      const overlapStart = Math.max(cursor, window.start);
      const overlapEnd = Math.min(endMs, window.end);
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }
    // Advance to the next local midnight
    cursor = nextLocalMidnight(cursor, expertTz);
  }

  return totalMs / MS_PER_HOUR;
}

/**
 * Compute the absolute UTC ms instant when an SLA budget of
 * `slaBusinessHours` business hours runs out, given the clock started
 * at `clockStartedMs` in the expert's tz.
 *
 * Returns null if clockStartedMs is null/undefined (clock not running).
 *
 * Algorithm: walk forward day by day, consuming the daily 12-hour
 * business window until the budget is exhausted, then compute the exact
 * cut-off instant within that day.
 */
export function slaDeadlineMs(
  clockStartedMs: number | null | undefined,
  slaBusinessHours: number,
  expertTz: string = DEFAULT_EXPERT_TZ,
): number | null {
  if (!clockStartedMs || slaBusinessHours <= 0) return null;

  let remainingMs = slaBusinessHours * MS_PER_HOUR;
  let cursor = clockStartedMs;
  const MAX_ITERATIONS = 365 * 5;
  let iterations = 0;

  while (remainingMs > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const window = businessWindowForDay(cursor, expertTz);
    if (window) {
      const segmentStart = Math.max(cursor, window.start);
      const segmentEnd = window.end;
      if (segmentEnd > segmentStart) {
        const segmentMs = segmentEnd - segmentStart;
        if (segmentMs >= remainingMs) {
          // Budget runs out inside this segment
          return segmentStart + remainingMs;
        }
        remainingMs -= segmentMs;
      }
    }
    cursor = nextLocalMidnight(cursor, expertTz);
  }
  // Fell off the end — return cursor as a safety floor
  return cursor;
}

/**
 * Convenience: returns true if the assignment is past its SLA deadline
 * NOW. Returns false if the clock hasn't started yet (null clock start).
 */
export function isOverdue(
  clockStartedMs: number | null | undefined,
  slaBusinessHours: number,
  expertTz: string = DEFAULT_EXPERT_TZ,
  nowMs: number = Date.now(),
): boolean {
  const deadline = slaDeadlineMs(clockStartedMs, slaBusinessHours, expertTz);
  if (deadline === null) return false;
  return nowMs >= deadline;
}

/**
 * Convenience: returns business hours remaining until the deadline.
 * Negative if past-due. Null if clock not started.
 */
export function businessHoursRemaining(
  clockStartedMs: number | null | undefined,
  slaBusinessHours: number,
  expertTz: string = DEFAULT_EXPERT_TZ,
  nowMs: number = Date.now(),
): number | null {
  if (!clockStartedMs) return null;
  const elapsed = businessHoursElapsed(clockStartedMs, nowMs, expertTz);
  return slaBusinessHours - elapsed;
}

export const SLA_DEFAULTS = {
  EXPERT_TZ: DEFAULT_EXPERT_TZ,
  BUSINESS_HOUR_START,
  BUSINESS_HOUR_END,
  DEFAULT_SLA_BUSINESS_HOURS: 24,
};
