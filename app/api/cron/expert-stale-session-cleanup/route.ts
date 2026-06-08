/**
 * GET /api/cron/expert-stale-session-cleanup
 *
 * Auto-closes any expert time-log session that's been open >12 hours.
 *
 * Why this exists:
 *   - Experts forget to clock out. The original timesheet UI had no
 *     "you've been clocked in for 17 hours" guard, so a forgotten clock-in
 *     would inflate `liveSessionHours` indefinitely on the timesheet view
 *     AND silently get skipped from the payroll close
 *     (admin-payroll/route.ts:140 only counts sessions with end_at set).
 *   - End result before this cron: a forgotten Friday-evening clock-in shows
 *     "73 hours projected pay" on the expert's timesheet Monday morning,
 *     and the admin payroll close excludes it, so the expert AND the
 *     admin see different (both wrong) numbers.
 *
 * Auto-close policy:
 *   - Sessions open >MAX_SHIFT_HOURS (12) get closed at start_at + 8 hours
 *     (a reasonable shift cap, not the runaway elapsed time).
 *   - tins_completed counted against the [start_at, auto-end] window.
 *   - notes annotated with "Auto-closed by system — open >12h".
 *   - Audit log records every auto-close.
 *
 * Schedule: daily at 14:00 UTC (= 7 AM PT / 10 AM ET) — fires after most
 * time zones' working days have ended, sweeping anyone who clocked in
 * yesterday and forgot to clock out.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const dynamic = 'force-dynamic';

const MAX_SHIFT_HOURS = 12;
const AUTO_CLOSE_AT_HOURS = 8; // safer cap than the elapsed runaway

export async function GET(req: NextRequest) {
  const unauthorized = requireBearer(req, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const now = new Date();
  const cutoff = new Date(now.getTime() - MAX_SHIFT_HOURS * 60 * 60 * 1000);

  // Find sessions open beyond MAX_SHIFT_HOURS
  const { data: stale } = await (admin
    .from('expert_time_logs') as any)
    .select('id, expert_id, start_at, break_minutes')
    .is('end_at', null)
    .lt('start_at', cutoff.toISOString())
    .limit(100) as { data: any[] | null };

  if (!stale || stale.length === 0) {
    return NextResponse.json({ closed: 0, scanned: 0 });
  }

  let closed = 0;
  const details: any[] = [];

  for (const row of stale) {
    const startAtMs = new Date(row.start_at).getTime();
    // Cap at AUTO_CLOSE_AT_HOURS from start_at so we don't credit the
    // expert with a 36-hour shift just because they forgot to clock out.
    const cappedEndAt = new Date(startAtMs + AUTO_CLOSE_AT_HOURS * 60 * 60 * 1000);
    const breakMin = Number(row.break_minutes) || 0;
    const grossMs = cappedEndAt.getTime() - startAtMs;
    const netHours = Math.max(0, grossMs / 3600000 - breakMin / 60);
    const hoursWorked = Math.round(netHours * 100) / 100;

    // Count TINs completed in [start_at, cappedEndAt] for this expert
    const { count: tins } = await admin
      .from('expert_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('expert_id', row.expert_id)
      .eq('status', 'completed')
      .gte('completed_at', row.start_at)
      .lte('completed_at', cappedEndAt.toISOString()) as { count: number | null };

    const noteSuffix = `\n[Auto-closed by system at ${now.toISOString()} — open >${MAX_SHIFT_HOURS}h. Capped at ${AUTO_CLOSE_AT_HOURS}h from clock-in.]`;
    const { error } = await (admin
      .from('expert_time_logs') as any)
      .update({
        end_at: cappedEndAt.toISOString(),
        hours_worked: hoursWorked,
        tins_completed: tins || 0,
        notes: noteSuffix,
        // NOTE: there is no `auto_closed` column on expert_time_logs — writing
        // it made PostgREST reject the ENTIRE update, so this cron silently
        // closed nothing. The audit trail lives in `notes` instead. (fixed 6/04)
      })
      .eq('id', row.id);

    if (!error) {
      closed++;
      details.push({
        log_id: row.id,
        expert_id: row.expert_id,
        opened_at: row.start_at,
        auto_closed_at: cappedEndAt.toISOString(),
        hours: hoursWorked,
        tins: tins || 0,
      });
    } else {
      console.error(`[expert-stale-session-cleanup] failed to close ${row.id}:`, error.message);
    }
  }

  console.log(`[expert-stale-session-cleanup] scanned=${stale.length} closed=${closed}`);

  return NextResponse.json({
    scanned: stale.length,
    closed,
    cutoff_hours: MAX_SHIFT_HOURS,
    capped_at_hours: AUTO_CLOSE_AT_HOURS,
    details,
  });
}
