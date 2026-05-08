/**
 * Phone-number pool + time-zone-aware picker.
 *
 * The IRS PPS is nominally "open 7am-7pm Mon-Fri" — but which 7am-7pm they
 * honor is determined by the AREA CODE of the caller, not the caller's
 * actual location. This lets us stretch the ModernTax calling window from
 * a single-timezone 12 hours to a cross-country 15 hours per weekday:
 *
 *   ET-area-code number (e.g. 212, 646, 617):  7am ET →  4am PT opens
 *   CT-area-code number (312, 773, 615):       7am CT →  5am PT opens
 *   MT-area-code number (303, 720, 602):       7am MT →  6am PT opens
 *   PT-area-code number (415, 310, 206):       7am PT →  7am PT opens
 *                                            PT number stays open until 7pm PT / 10pm ET
 *
 * By maintaining one active outbound number per US timezone, we can fire an
 * IRS call at any moment between 4am PT and 7pm PT — 15 hours × N concurrent
 * calls/number as we scale. Combined with Retell's programmatic transfer
 * and multi-call concurrency, the theoretical daily throughput is:
 *
 *   15 hrs × 60 min/hr × N phones × (1 call / 40 min avg) × 5 entities/call
 *   = 112 × N entities/day (before fax-wait derate)
 *
 * For 4 phones: ≈ 450 entities/weekday capacity. Real-world throughput will
 * depend on IRS callback policy + Retell concurrency limits.
 *
 * Configuration: `RETELL_PHONE_POOL` env var, JSON array of pool entries:
 *
 *   RETELL_PHONE_POOL='[
 *     {"phone":"+12125550100","tz":"America/New_York",    "area_code":212,"label":"NY-212"},
 *     {"phone":"+13125550100","tz":"America/Chicago",     "area_code":312,"label":"Chicago-312"},
 *     {"phone":"+17205550100","tz":"America/Denver",      "area_code":720,"label":"Denver-720"},
 *     {"phone":"+14155550100","tz":"America/Los_Angeles","area_code":415,"label":"SF-415"}
 *   ]'
 *
 * Fallback: `RETELL_IRS_FROM_NUMBER` (single-number mode) still works if
 * the pool env is missing — lets Matt start with 1 number before buying 4.
 */

export interface PhonePoolEntry {
  /** E.164 formatted Retell outbound number, e.g. "+14155551234". */
  phone: string;
  /** IANA timezone string the IRS will honor for this number (by area code). */
  tz: string;
  /** Leading NANP area code — used for documentation only, not logic. */
  area_code?: number;
  /** Human-friendly label for dashboards + logs, e.g. "NY-212". */
  label?: string;
}

/**
 * IRS PPS business hours (local time in the area-code timezone).
 * If the IRS ever changes this, bump here.
 */
const IRS_PPS_OPEN_HOUR  = 7;   // 7:00 AM local
const IRS_PPS_CLOSE_HOUR = 19;  // 7:00 PM local (exclusive)

export function loadPhonePool(): PhonePoolEntry[] {
  const raw = process.env.RETELL_PHONE_POOL;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (err) {
      console.error('[phone-pool] RETELL_PHONE_POOL is not valid JSON — falling back to single-number mode', err);
    }
  }
  // Fallback: single number from RETELL_IRS_FROM_NUMBER, tz unknown (assume PT).
  const single = process.env.RETELL_IRS_FROM_NUMBER;
  if (single) {
    return [{
      phone: single,
      tz: process.env.RETELL_IRS_FROM_TZ || 'America/Los_Angeles',
      label: 'default',
    }];
  }
  return [];
}

/**
 * Return the hour-of-day (0-23) in the given IANA timezone, right now.
 * Used to check whether an area-code number is currently inside IRS hours.
 */
export function localHour(tz: string, at: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  const h = parseInt(fmt.format(at), 10);
  // Intl sometimes returns "24" for midnight in certain locales; normalise.
  return h === 24 ? 0 : h;
}

/**
 * Return the day-of-week (0=Sun, 6=Sat) in the given IANA timezone, right now.
 */
export function localDay(tz: string, at: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  });
  const s = fmt.format(at);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[s] ?? 0;
}

/**
 * Is the IRS PPS currently accepting calls FROM a number with the given tz?
 * Mon-Fri, 7am-7pm local, no federal-holiday handling yet (TODO).
 */
export function isIrsOpenFor(tz: string, at: Date = new Date()): boolean {
  const day = localDay(tz, at);
  if (day === 0 || day === 6) return false;
  const hr = localHour(tz, at);
  return hr >= IRS_PPS_OPEN_HOUR && hr < IRS_PPS_CLOSE_HOUR;
}

/**
 * Pick the best from-number for an outbound IRS call right now.
 *
 * Strategy (priority order):
 *   1. ONLY numbers whose tz currently falls inside IRS open hours.
 *   2. Prefer the tz closest to "just opened" vs "about to close" — buys us
 *      the longest remaining productive window without having to repick.
 *   3. Stable tie-break by pool index so the same slot always maps to the
 *      same number (good for observability + sticky concurrency slots).
 *
 * Returns null if nothing is currently in IRS hours (e.g., 9pm PT on
 * Tuesday — even the PT number is closed).
 */
export function pickFromNumber(
  pool: PhonePoolEntry[] = loadPhonePool(),
  at: Date = new Date(),
  excludeNumbers: string[] = [],
): PhonePoolEntry | null {
  if (pool.length === 0) return null;

  // MOD-211: in a retry chain, callers pass the from-numbers already
  // tried for this entity so we rotate to a fresh one. If every number
  // has been tried, fall back to the entire pool (better to retry from
  // any open number than fail).
  const excluded = new Set(excludeNumbers);
  const filtered = pool.filter(p => !excluded.has(p.phone));
  const candidates = filtered.length > 0 ? filtered : pool;

  const eligible = candidates
    .map((entry, idx) => {
      const hr = localHour(entry.tz, at);
      const open = isIrsOpenFor(entry.tz, at);
      // "Remaining window hours" = hours left until local close, clamped to 0 if closed.
      const remaining = open ? IRS_PPS_CLOSE_HOUR - hr : 0;
      return { entry, idx, open, hr, remaining };
    })
    .filter(x => x.open);

  if (eligible.length === 0) return null;

  // Most remaining window first; stable tie-break by pool index.
  eligible.sort((a, b) => (b.remaining - a.remaining) || (a.idx - b.idx));
  return eligible[0].entry;
}

/**
 * Human-friendly description of the current calling window across the pool.
 * Used by the admin dashboard + scheduler logs.
 */
export function describeCallingWindow(
  pool: PhonePoolEntry[] = loadPhonePool(),
  at: Date = new Date(),
): string {
  if (pool.length === 0) return 'No phone numbers configured.';
  const lines = pool.map(entry => {
    const hr = localHour(entry.tz, at);
    const open = isIrsOpenFor(entry.tz, at);
    return `  ${(entry.label || entry.phone).padEnd(18)} ${entry.tz.padEnd(22)} hr=${String(hr).padStart(2)}  ${open ? '✓ OPEN' : '✗ closed'}`;
  });
  return lines.join('\n');
}
