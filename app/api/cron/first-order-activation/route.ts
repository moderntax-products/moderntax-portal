/**
 * Cron: first-order activation — the never-activated cohort.
 *
 * lib/order-growth.ts deliberately skips anyone with zero orders ("Track A's
 * job"), and reengagement Track A has never sent a real email, so this cohort
 * received nothing at all. On 2026-07-22 that was 20 approved users with zero
 * orders while we ran ~1.6 orders/day against a 50/day target.
 *
 * WHAT MAKES THIS DIFFERENT FROM A NORMAL DRIP
 * --------------------------------------------
 * It refuses to email anyone who cannot complete the action it's asking for.
 * Each candidate is run through checkOrderGate() first; anyone blocked is
 * reported in `blocked` and NOT emailed.
 *
 * That came out of finding, on 2026-07-21/22, that most of this "disinterested"
 * cohort was actually blocked by our own defects — profiles with a NULL
 * client_id that made every intake route 400, a sales-led account 402'ing on
 * card_required, and a request-body cap that made scanned 8821s unuploadable.
 * Nudging people into those walls would have burned real intent.
 *
 * Treat a non-empty `blocked` list as a bug queue, not an audience.
 *
 * SAFETY / ANTI-SPAM:
 *  - SHADOW BY DEFAULT behind FIRST_ORDER_AUTOSEND=true.
 *  - Never emails a blocked user (the whole point).
 *  - Excludes internal/demo accounts, disposable signups, and the explicit
 *    DO_NOT_SEND list.
 *  - 21-day per-user cooldown; suppressed if reengagement or order-growth
 *    touched them in the last 10 days. Shadow reengagement rows do NOT
 *    suppress (that bug is fixed in order-growth #75 and avoided here).
 *  - Skips accounts younger than 2 days.
 *  - Hard cap MAX_SENDS_PER_RUN.
 *  - Weekday-only.
 *
 * Auth: Vercel cron Bearer secret. `?force=true` previews off-schedule.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logAuditEvent } from '@/lib/audit';
import {
  findActivationTargets, recentlyTouched, recentlyReengaged, sendFirstOrderNudge,
  ACTIVATION_ACTION, ACTIVATION_COOLDOWN_DAYS, RECENT_TOUCH_DAYS, MAX_SENDS_PER_RUN,
} from '@/lib/first-order-activation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const autoSend = process.env.FIRST_ORDER_AUTOSEND === 'true';
  const force = request.nextUrl.searchParams.get('force') === 'true';
  const admin = createAdminClient();

  const la = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const isWeekend = la.getDay() === 0 || la.getDay() === 6;

  const result = {
    mode: autoSend ? 'live' : 'shadow',
    eligible: 0,
    sent: 0,
    skipped_cooldown: 0,
    skipped_recent_touch: 0,
    skipped_filtered: 0,
    recipients: [] as string[],
    /** Users who CANNOT order. These are product defects — fix, don't email. */
    blocked: [] as Array<{ email: string; client: string | null; reason: string }>,
    errors: [] as string[],
  };

  if (isWeekend && !force) {
    return NextResponse.json({ ...result, note: 'weekend — skipped' });
  }

  try {
    const { targets, blocked, skipped } = await findActivationTargets(admin);
    result.eligible = targets.length;
    result.skipped_filtered = skipped;
    result.blocked = blocked.map((b) => ({
      email: b.email,
      client: b.client_name,
      reason: b.reason,
    }));

    if (blocked.length > 0) {
      console.warn(
        `[first-order-activation] ${blocked.length} user(s) CANNOT order — not emailed:`,
        blocked.map((b) => `${b.email} (${b.reason})`).join('; '),
      );
    }

    const cooled = await recentlyTouched(admin, [ACTIVATION_ACTION], ACTIVATION_COOLDOWN_DAYS);
    const touched = await recentlyTouched(
      admin,
      ['order_nudge_weekly', 'order_nudge_next'],
      RECENT_TOUCH_DAYS,
    );
    const reengaged = await recentlyReengaged(admin);

    let budget = MAX_SENDS_PER_RUN;

    for (const t of targets) {
      if (budget <= 0) break;
      if (cooled.has(t.id)) { result.skipped_cooldown++; continue; }
      if (touched.has(t.id) || reengaged.has(t.id)) { result.skipped_recent_touch++; continue; }

      result.recipients.push(`${t.email} (${t.client_name || '—'}, ${t.daysSinceSignup}d)`);

      if (autoSend) {
        const ok = await sendFirstOrderNudge(t);
        if (ok) {
          result.sent++;
          budget--;
          await logAuditEvent(admin, {
            action: ACTIVATION_ACTION,
            resourceType: 'profile',
            resourceId: t.id,
            userId: t.id,
            details: {
              email: t.email,
              client: t.client_name,
              days_since_signup: t.daysSinceSignup,
              teammate_orders: t.teammateOrders,
            },
          });
        } else {
          result.errors.push(`send failed: ${t.email}`);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(e?.message || String(e));
  }

  return NextResponse.json(result);
}
