/**
 * Cron: order-growth nudges — the daily-order-volume engine.
 *
 * Two touches toward the ~50 orders/day target:
 *   1. NEXT-ORDER (daily) — every order that completed in the last ~24h earns
 *      the processor a "that's done, what's next?" nudge. Every completion
 *      becomes an invitation to reorder. This is the compounding lever.
 *   2. WEEKLY LAPSED (Tuesdays) — processors with zero orders in the last 7
 *      days get one light nudge, at most once a week.
 *
 * SAFETY / ANTI-SPAM:
 *  - SHADOW BY DEFAULT. Gated behind ORDER_GROWTH_AUTOSEND=true, mirroring
 *    REENGAGEMENT_AUTOSEND. Until set, it computes the audience and logs what it
 *    WOULD send, and sends nothing. Review a shadow run before flipping it.
 *  - Suppresses anyone the reengagement sequence touched in the last 10 days,
 *    so a dormant processor never gets both this and a Track B step.
 *  - Per-processor weekly cooldown + per-request dedupe, both via audit_log
 *    (no migration needed).
 *  - Respects profiles.nudges_paused and approval_status.
 *  - Hard cap MAX_SENDS_PER_RUN so a bad query can't blast the book.
 *  - Weekday-only for the weekly touch (nobody wants a Saturday sales nudge).
 *
 * Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { logAuditEvent } from '@/lib/audit';
import {
  findLapsedProcessors, findRecentCompletions, recentlyReengaged, alreadySent,
  sendWeeklyOrderNudge, sendNextOrderNudge,
  LAPSED_DAYS, WEEKLY_COOLDOWN_DAYS, MAX_SENDS_PER_RUN, DAILY_ORDER_TARGET,
} from '@/lib/order-growth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WEEKLY_DOW = 2; // Tuesday, in America/Los_Angeles

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const autoSend = process.env.ORDER_GROWTH_AUTOSEND === 'true';
  const force = request.nextUrl.searchParams.get('force') === 'true'; // manual preview
  const admin = createAdminClient();

  const laTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const la = new Date(laTime);
  const isWeeklyDay = la.getDay() === WEEKLY_DOW;
  const isWeekend = la.getDay() === 0 || la.getDay() === 6;

  const result = {
    mode: autoSend ? 'live' : 'shadow',
    daily_order_target: DAILY_ORDER_TARGET,
    next_order: { eligible: 0, sent: 0, skipped_deduped: 0, recipients: [] as string[] },
    weekly_lapsed: { ran: false, eligible: 0, sent: 0, skipped_reengaged: 0, skipped_cooldown: 0, recipients: [] as string[] },
    errors: [] as string[],
  };

  let budget = MAX_SENDS_PER_RUN;

  // ── 1. NEXT-ORDER (daily, weekdays only) ────────────────────────────────
  if (!isWeekend || force) {
    try {
      const completions = await findRecentCompletions(admin);
      const done = await alreadySent(admin, 'order_nudge_next', 3);
      result.next_order.eligible = completions.length;
      for (const c of completions) {
        if (budget <= 0) break;
        if (done.has(c.request_id)) { result.next_order.skipped_deduped++; continue; }
        result.next_order.recipients.push(`${c.email} (loan ${c.loan_number || '—'})`);
        if (autoSend) {
          const ok = await sendNextOrderNudge(c);
          if (ok) {
            result.next_order.sent++;
            budget--;
            await logAuditEvent(admin, {
              action: 'order_nudge_next', userId: c.id, userEmail: c.email,
              resourceType: 'request', resourceId: c.request_id,
              details: { loan_number: c.loan_number, entity_count: c.entity_count, order_count: c.orderCount },
            });
          }
        }
      }
    } catch (e: any) {
      result.errors.push(`next_order: ${e?.message || e}`);
    }
  }

  // ── 2. WEEKLY LAPSED (Tuesdays) ─────────────────────────────────────────
  if (isWeeklyDay || force) {
    result.weekly_lapsed.ran = true;
    try {
      const lapsed = await findLapsedProcessors(admin, LAPSED_DAYS);
      const reengaged = await recentlyReengaged(admin);
      const cooled = await alreadySent(admin, 'order_nudge_weekly', WEEKLY_COOLDOWN_DAYS);
      result.weekly_lapsed.eligible = lapsed.length;
      for (const p of lapsed) {
        if (budget <= 0) break;
        if (reengaged.has(p.id)) { result.weekly_lapsed.skipped_reengaged++; continue; }
        if (cooled.has(p.id)) { result.weekly_lapsed.skipped_cooldown++; continue; }
        result.weekly_lapsed.recipients.push(`${p.email} (${p.daysSinceLastOrder}d, ${p.orderCount} orders)`);
        if (autoSend) {
          const ok = await sendWeeklyOrderNudge(p);
          if (ok) {
            result.weekly_lapsed.sent++;
            budget--;
            await logAuditEvent(admin, {
              action: 'order_nudge_weekly', userId: p.id, userEmail: p.email,
              resourceType: 'profile', resourceId: p.id,
              details: { days_since_last_order: p.daysSinceLastOrder, order_count: p.orderCount },
            });
          }
        }
      }
    } catch (e: any) {
      result.errors.push(`weekly_lapsed: ${e?.message || e}`);
    }
  }

  console.log(`[order-growth] ${result.mode} — next_order: ${result.next_order.sent}/${result.next_order.eligible}, weekly: ${result.weekly_lapsed.sent}/${result.weekly_lapsed.eligible}`);
  return NextResponse.json({ success: true, ...result });
}
