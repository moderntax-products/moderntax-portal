/**
 * Expert timesheet API.
 *
 * GET  /api/expert/timesheet
 *   Returns:
 *     - active_session: open clock-in row, or null
 *     - current_period: { period_start, period_end, totals: SessionTotals, sla_met_pct, log_count }
 *     - recent_periods: last 8 closed pay periods (rolled-up)
 *     - recent_logs: last 10 sessions
 *     - profile: { hourly_rate, target_tins_per_hour, payment_method }
 *
 * POST /api/expert/timesheet
 *   Body: { action: 'clock_in' }                      → opens a new session
 *   Body: { action: 'clock_out', notes?, break_minutes? } → closes the open session,
 *          auto-counts TINs the expert completed during [start, end].
 *   Body: { action: 'log_manual', start_at, end_at, break_minutes?, tins_completed?, notes? }
 *          → admin / expert manually logs a past session (for entries that pre-date
 *            the live clock or were missed). tins_completed defaults to auto-count
 *            from request_entities.completed_at within the window.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import {
  computeSessionTotals,
  computeSlaMetPct,
  liveSessionHours,
  payPeriodFor,
  PAYROLL_DEFAULTS,
} from '@/lib/expert-payroll';
import { SLA_DEFAULTS } from '@/lib/expert-sla';

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await (supabase
    .from('profiles')
    .select('id, role, hourly_rate, target_tins_per_hour, payment_method, iana_timezone')
    .eq('id', user.id)
    .single() as any) as { data: any };

  // Allow expert (own data) AND admin (QA preview / their own row will
  // be empty unless they've clocked in). Other roles: 403.
  if (!profile || !['expert', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Expert-only' }, { status: 403 });
  }

  const admin = createAdminClient();
  const hourlyRate = Number(profile.hourly_rate) || PAYROLL_DEFAULTS.HOURLY_RATE;
  const targetRate = Number(profile.target_tins_per_hour) || PAYROLL_DEFAULTS.TARGET_TINS_PER_HOUR;
  const expertTz = profile.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;

  // Active (open) session — ends_at IS NULL
  const { data: activeSession } = await (admin
    .from('expert_time_logs' as any) as any)
    .select('*')
    .eq('expert_id', user.id)
    .is('end_at', null)
    .order('start_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Current pay period bounds
  const now = new Date();
  const { periodStart, periodEnd, payDate } = payPeriodFor(now);
  const periodStartIso = periodStart.toISOString();
  const periodEndIso = new Date(periodEnd.getTime() + 24 * 3600 * 1000).toISOString(); // exclusive end

  // All sessions in the current pay period (including the open one)
  const { data: periodLogs } = await (admin
    .from('expert_time_logs' as any) as any)
    .select('id, start_at, end_at, hours_worked, tins_completed, break_minutes, notes')
    .eq('expert_id', user.id)
    .gte('start_at', periodStartIso)
    .lt('start_at', periodEndIso)
    .order('start_at', { ascending: false });

  let totalHours = 0;
  let totalTins = 0;
  for (const row of (periodLogs as any[]) || []) {
    const h = row.end_at
      ? Number(row.hours_worked) || 0
      : liveSessionHours(row.start_at, Number(row.break_minutes) || 0);
    totalHours += h;
    totalTins += Number(row.tins_completed) || 0;
  }
  const periodTotals = computeSessionTotals(totalHours, totalTins, hourlyRate, targetRate);

  // SLA-met % across THIS period's completed assignments by this expert
  const { data: periodCompletedAssignments } = await (admin
    .from('expert_assignments' as any) as any)
    .select('expert_clock_started_at, completed_at, sla_business_hours')
    .eq('expert_id', user.id)
    .eq('status', 'completed')
    .gte('completed_at', periodStartIso)
    .lt('completed_at', periodEndIso);
  const slaMetPct = computeSlaMetPct((periodCompletedAssignments as any) || [], expertTz);

  // Recent closed pay periods — pulled from the rolled-up table if present,
  // else returned empty (admin will create the row when they approve payouts).
  const { data: recentPeriods } = await (admin
    .from('expert_pay_periods' as any) as any)
    .select('id, period_start, period_end, pay_date, total_hours, total_tins, expected_tins, efficiency_pct, sla_met_pct, gross_pay, status, paid_at, payment_reference, notes')
    .eq('expert_id', user.id)
    .order('period_start', { ascending: false })
    .limit(8);

  // Recent sessions (for the timesheet history scroll)
  const { data: recentLogs } = await (admin
    .from('expert_time_logs' as any) as any)
    .select('id, start_at, end_at, hours_worked, tins_completed, break_minutes, notes, pay_period_id')
    .eq('expert_id', user.id)
    .order('start_at', { ascending: false })
    .limit(10);

  return NextResponse.json({
    profile: {
      hourly_rate: hourlyRate,
      target_tins_per_hour: targetRate,
      payment_method: profile.payment_method || 'stripe_connect',
      iana_timezone: expertTz,
    },
    active_session: activeSession || null,
    current_period: {
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      pay_date: payDate.toISOString().slice(0, 10),
      totals: periodTotals,
      sla_met_pct: slaMetPct,
      log_count: (periodLogs || []).length,
    },
    recent_periods: recentPeriods || [],
    recent_logs: recentLogs || [],
  });
}

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null; error: any };

  // Allow expert (own data) AND admin (QA preview / their own row will
  // be empty unless they've clocked in). Other roles: 403.
  if (!profile || !['expert', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: 'Expert-only' }, { status: 403 });
  }

  const admin = createAdminClient();
  const body = await request.json().catch(() => ({} as any));
  const action = body.action;

  if (action === 'clock_in') {
    // Refuse to open a 2nd session if one is already open.
    const { data: existingOpen } = await (admin
      .from('expert_time_logs' as any) as any)
      .select('id, start_at')
      .eq('expert_id', user.id)
      .is('end_at', null)
      .maybeSingle();
    if (existingOpen) {
      return NextResponse.json({
        error: 'Already clocked in',
        detail: 'You have an open session — clock out first or refresh the page.',
        active_session_id: existingOpen.id,
      }, { status: 409 });
    }
    const { data: created, error } = await (admin
      .from('expert_time_logs' as any) as any)
      .insert({ expert_id: user.id })
      .select('id, start_at')
      .single();
    if (error) return NextResponse.json({ error: 'Clock-in failed', detail: error.message }, { status: 500 });
    return NextResponse.json({ success: true, action: 'clock_in', session: created });
  }

  if (action === 'clock_out') {
    const breakMinutes = Number(body.break_minutes) || 0;
    const notes = (body.notes || '').trim() || null;
    const endAt = new Date();

    // Find the open session
    const { data: open } = await (admin
      .from('expert_time_logs' as any) as any)
      .select('id, start_at')
      .eq('expert_id', user.id)
      .is('end_at', null)
      .order('start_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!open) {
      return NextResponse.json({ error: 'No active session', detail: 'Clock in first.' }, { status: 400 });
    }

    const startAtMs = new Date(open.start_at).getTime();
    const elapsedMs = Math.max(0, endAt.getTime() - startAtMs) - breakMinutes * 60_000;
    const hoursWorked = Math.max(0, elapsedMs / 3_600_000);

    // Auto-count TINs completed in this window by this expert
    const { count: tinsCompleted } = await (admin
      .from('expert_assignments' as any) as any)
      .select('id', { count: 'exact', head: true })
      .eq('expert_id', user.id)
      .eq('status', 'completed')
      .gte('completed_at', open.start_at)
      .lte('completed_at', endAt.toISOString());

    const { error: upErr } = await (admin
      .from('expert_time_logs' as any) as any)
      .update({
        end_at: endAt.toISOString(),
        break_minutes: breakMinutes,
        hours_worked: Math.round(hoursWorked * 100) / 100,
        tins_completed: tinsCompleted || 0,
        notes,
        updated_at: endAt.toISOString(),
      })
      .eq('id', open.id);

    if (upErr) return NextResponse.json({ error: 'Clock-out failed', detail: upErr.message }, { status: 500 });

    return NextResponse.json({
      success: true,
      action: 'clock_out',
      hours_worked: Math.round(hoursWorked * 100) / 100,
      tins_completed: tinsCompleted || 0,
    });
  }

  if (action === 'log_manual') {
    const startAt = body.start_at && new Date(body.start_at);
    const endAt = body.end_at && new Date(body.end_at);
    if (!startAt || !endAt || !(startAt < endAt)) {
      return NextResponse.json({ error: 'start_at and end_at required (end after start)' }, { status: 400 });
    }
    const breakMinutes = Number(body.break_minutes) || 0;
    const notes = (body.notes || '').trim() || null;
    const elapsedMs = endAt.getTime() - startAt.getTime() - breakMinutes * 60_000;
    const hoursWorked = Math.max(0, elapsedMs / 3_600_000);

    // Auto-count TINs in window unless caller explicitly supplied a count
    let tinsCompleted: number;
    if (typeof body.tins_completed === 'number') {
      tinsCompleted = body.tins_completed;
    } else {
      const { count } = await (admin
        .from('expert_assignments' as any) as any)
        .select('id', { count: 'exact', head: true })
        .eq('expert_id', user.id)
        .eq('status', 'completed')
        .gte('completed_at', startAt.toISOString())
        .lte('completed_at', endAt.toISOString());
      tinsCompleted = count || 0;
    }

    const { data: created, error } = await (admin
      .from('expert_time_logs' as any) as any)
      .insert({
        expert_id: user.id,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        break_minutes: breakMinutes,
        hours_worked: Math.round(hoursWorked * 100) / 100,
        tins_completed: tinsCompleted,
        notes,
      })
      .select('id, start_at, end_at, hours_worked, tins_completed')
      .single();
    if (error) return NextResponse.json({ error: 'Log failed', detail: error.message }, { status: 500 });
    return NextResponse.json({ success: true, action: 'log_manual', session: created });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
