/**
 * Business-day timezone helpers.
 *
 * ModernTax operates across two coasts. The "daily window" for stats and
 * summaries is **4 AM PT (start) to 7 PM ET (end)** — earliest west-coast
 * worker active through latest east-coast worker shutdown. Crons that report
 * "today's activity" need to anchor on this window, NOT on UTC midnight
 * (which silently shifts to the previous day in PT and clips off the last
 * hour of ET activity).
 *
 * All helpers below stay correct across PDT ↔ PST transitions because we
 * round-trip through Intl rather than hard-coding the offset.
 *
 * Conventions:
 *   - "Pacific date" / "Today PT" → the YYYY-MM-DD that PT considers today
 *   - "Business-day window" → [4 AM PT today, now]
 *   - All returned Date objects are UTC (use .toISOString() for SQL)
 */

const PT = 'America/Los_Angeles';
const ET = 'America/New_York';

/**
 * Returns a UTC Date corresponding to "today at HH:00 in Pacific time".
 *
 * Example (May = PDT, UTC-7): hourPacific(now, 4) → today 11:00 UTC.
 * Example (Dec = PST, UTC-8): hourPacific(now, 4) → today 12:00 UTC.
 * Day-rollover safe: if `now` is 8 PM PT (= next-UTC-day 03:00), the
 * returned 4 AM is from the SAME PT day (= 11 AM UTC of the same UTC day),
 * not from the next UTC day.
 */
export function hourPacific(now: Date, hour: number): Date {
  const ptDate = now.toLocaleDateString('en-CA', { timeZone: PT });
  const probe = new Date(`${ptDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  const ptHour = Number(
    probe.toLocaleString('en-US', { timeZone: PT, hour: 'numeric', hour12: false }),
  );
  const offset = (hour - ptHour + 24) % 24;
  const targetUtcHour = (hour + offset) % 24;
  return new Date(`${ptDate}T${String(targetUtcHour).padStart(2, '0')}:00:00Z`);
}

/**
 * Same as hourPacific but for Eastern. Useful when something is anchored
 * to the ET workday (e.g. IRS PPS hours).
 */
export function hourEastern(now: Date, hour: number): Date {
  const etDate = now.toLocaleDateString('en-CA', { timeZone: ET });
  const probe = new Date(`${etDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  const etHour = Number(
    probe.toLocaleString('en-US', { timeZone: ET, hour: 'numeric', hour12: false }),
  );
  const offset = (hour - etHour + 24) % 24;
  const targetUtcHour = (hour + offset) % 24;
  return new Date(`${etDate}T${String(targetUtcHour).padStart(2, '0')}:00:00Z`);
}

/**
 * The start of ModernTax's business day for "today" — 4 AM Pacific.
 * Used as the lower bound of any "completed today / new today" SQL gte.
 */
export function businessDayStart(now: Date = new Date()): Date {
  return hourPacific(now, 4);
}

/**
 * The end of ModernTax's business day — 7 PM Eastern. Returns a date in the
 * future (relative to `now`) when called mid-day; equal to `now` if we're
 * already past 7 PM ET. Use Math.min(end, now) when bounding queries.
 */
export function businessDayEnd(now: Date = new Date()): Date {
  return hourEastern(now, 19);
}

/**
 * Today's Pacific calendar date as YYYY-MM-DD. For UI labels and date keys
 * (e.g. expert_call_schedule.schedule_date) that should be PT-anchored.
 */
export function pacificDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: PT });
}

/**
 * Human-readable date label in Pacific time. Used in email subject lines
 * and headers — guarantees the email says "Wednesday, May 6" even if the
 * cron runs after 5 PM PT (when UTC has already rolled to Thursday).
 */
export function pacificDateLabel(now: Date = new Date()): string {
  return now.toLocaleDateString('en-US', {
    timeZone: PT,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Rolling business-week window: [7 days ago at 4 AM PT, now].
 * Used by manager-weekly-summary and nudge — keeps the rolling window
 * consistent regardless of when the cron actually fires.
 *
 * Returns weekRange as a "May 1 – May 8, 2026" style string in PT.
 */
export function rollingBusinessWeek(now: Date = new Date()): {
  start: Date;
  end: Date;
  rangeLabel: string;
} {
  const todayStart = businessDayStart(now);
  const start = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' });
  const yr = now.toLocaleDateString('en-US', { timeZone: PT, year: 'numeric' });
  return {
    start,
    end: now,
    rangeLabel: `${fmt(start)} – ${fmt(now)}, ${yr}`,
  };
}
