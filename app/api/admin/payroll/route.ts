/**
 * Admin payroll API.
 *
 * GET /api/admin/payroll?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 *   Returns the per-expert summary for a pay period (or current period
 *   if no params). Each row pulls live totals from expert_time_logs +
 *   expert_assignments (auto-counted TINs + SLA-met %) so admin always
 *   sees current numbers, not stale rolled-up rows.
 *
 * POST /api/admin/payroll
 *   Body: { action: 'close_period', expert_id, period_start, period_end, notes? }
 *     → upserts an expert_pay_periods row with status='approved' and stamps
 *       pay_period_id on every contributing time-log.
 *   Body: { action: 'mark_paid', period_id, payment_reference?, notes? }
 *     → flips status to 'paid', records paid_at / paid_by / payment_reference.
 *   Body: { action: 'edit_log', log_id, hours_worked?, tins_completed?, notes? }
 *     → admin override of an individual session row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import {
  computeSessionTotals,
  computeSlaMetPct,
  payPeriodFor,
  PAYROLL_DEFAULTS,
} from '@/lib/expert-payroll';
import { SLA_DEFAULTS } from '@/lib/expert-sla';

async function requireAdmin() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' as const, status: 401 };
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .single() as { data: { role: string; email: string } | null; error: any };
  if (!profile || profile.role !== 'admin') return { error: 'Admin-only' as const, status: 403 };
  return { ok: true as const, user, profile };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const periodStartParam = url.searchParams.get('period_start');
  const periodEndParam = url.searchParams.get('period_end');

  let periodStart: Date;
  let periodEnd: Date;
  if (periodStartParam && periodEndParam) {
    periodStart = new Date(periodStartParam);
    periodEnd = new Date(periodEndParam);
  } else {
    const cur = payPeriodFor(new Date());
    periodStart = cur.periodStart;
    periodEnd = cur.periodEnd;
  }
  const startIso = periodStart.toISOString();
  const endExclusiveIso = new Date(periodEnd.getTime() + 24 * 3600 * 1000).toISOString();

  const admin = createAdminClient();

  // All experts (active + inactive)
  const { data: experts } = await (admin
    .from('profiles' as any) as any)
    .select('id, full_name, email, hourly_rate, target_tins_per_hour, payment_method, iana_timezone, role')
    .eq('role', 'expert')
    .order('full_name', { ascending: true });

  if (!experts || experts.length === 0) {
    return NextResponse.json({
      period: {
        start: periodStart.toISOString().slice(0, 10),
        end: periodEnd.toISOString().slice(0, 10),
        pay_date: new Date(periodEnd.getTime() + PAYROLL_DEFAULTS.PAY_DATE_LAG_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10),
      },
      experts: [],
      total_gross: 0,
    });
  }

  const expertIds: string[] = experts.map((e: any) => e.id);

  // All time logs in the window (one shot, then group in JS)
  const { data: logs } = await (admin
    .from('expert_time_logs' as any) as any)
    .select('id, expert_id, start_at, end_at, hours_worked, tins_completed, break_minutes, notes')
    .in('expert_id', expertIds)
    .gte('start_at', startIso)
    .lt('start_at', endExclusiveIso);

  // All completed assignments in the window for SLA-met %
  const { data: completed } = await (admin
    .from('expert_assignments' as any) as any)
    .select('expert_id, expert_clock_started_at, completed_at, sla_business_hours')
    .in('expert_id', expertIds)
    .eq('status', 'completed')
    .gte('completed_at', startIso)
    .lt('completed_at', endExclusiveIso);

  // Existing pay-period rows in the window (so admin can see what's already approved/paid)
  const { data: periodRows } = await (admin
    .from('expert_pay_periods' as any) as any)
    .select('*')
    .in('expert_id', expertIds)
    .eq('period_start', periodStart.toISOString().slice(0, 10))
    .eq('period_end', periodEnd.toISOString().slice(0, 10));

  const logsByExpert = new Map<string, any[]>();
  for (const l of (logs || []) as any[]) {
    const arr = logsByExpert.get(l.expert_id) || [];
    arr.push(l);
    logsByExpert.set(l.expert_id, arr);
  }
  const completedByExpert = new Map<string, any[]>();
  for (const c of (completed || []) as any[]) {
    const arr = completedByExpert.get(c.expert_id) || [];
    arr.push(c);
    completedByExpert.set(c.expert_id, arr);
  }
  const periodByExpert = new Map<string, any>();
  for (const p of (periodRows || []) as any[]) periodByExpert.set(p.expert_id, p);

  let totalGross = 0;
  const expertSummaries = experts.map((ex: any) => {
    const expertLogs = logsByExpert.get(ex.id) || [];
    const expertCompleted = completedByExpert.get(ex.id) || [];
    const tz = ex.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;
    const hourlyRate = Number(ex.hourly_rate) || PAYROLL_DEFAULTS.HOURLY_RATE;
    const targetRate = Number(ex.target_tins_per_hour) || PAYROLL_DEFAULTS.TARGET_TINS_PER_HOUR;

    let totalHours = 0;
    let totalTins = 0;
    let openSessionCount = 0;
    let openSessionOldestStart: string | null = null;
    for (const l of expertLogs) {
      if (!l.end_at) {
        // Open session — counted in a separate "needs attention" bucket so
        // the admin sees them before close-period, instead of silently zero.
        openSessionCount++;
        if (!openSessionOldestStart || l.start_at < openSessionOldestStart) {
          openSessionOldestStart = l.start_at;
        }
        continue;
      }
      totalHours += Number(l.hours_worked) || 0;
      totalTins += Number(l.tins_completed) || 0;
    }
    const totals = computeSessionTotals(totalHours, totalTins, hourlyRate, targetRate);
    const slaMetPct = computeSlaMetPct(expertCompleted, tz);
    totalGross += totals.grossPay;

    const existingPeriod = periodByExpert.get(ex.id) || null;
    return {
      expert_id: ex.id,
      expert_name: ex.full_name || ex.email,
      expert_email: ex.email,
      hourly_rate: hourlyRate,
      target_tins_per_hour: targetRate,
      payment_method: ex.payment_method || 'stripe_connect',
      log_count: expertLogs.length,
      live_totals: totals,
      sla_met_pct: slaMetPct,
      // Open-session warning fields — admin should resolve these before
      // closing the period, otherwise the hours go uncounted. The
      // expert-stale-session-cleanup cron auto-closes anything >12h;
      // anything still open is a same-day shift in progress.
      open_session_count: openSessionCount,
      open_session_oldest_start: openSessionOldestStart,
      existing_period: existingPeriod
        ? {
            id: existingPeriod.id,
            status: existingPeriod.status,
            paid_at: existingPeriod.paid_at,
            payment_reference: existingPeriod.payment_reference,
            gross_pay: Number(existingPeriod.gross_pay),
            notes: existingPeriod.notes,
          }
        : null,
    };
  });

  return NextResponse.json({
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: periodEnd.toISOString().slice(0, 10),
      pay_date: new Date(periodEnd.getTime() + PAYROLL_DEFAULTS.PAY_DATE_LAG_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10),
    },
    experts: expertSummaries,
    total_gross: Math.round(totalGross * 100) / 100,
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { user, profile } = auth;

  const admin = createAdminClient();
  const body = await request.json().catch(() => ({} as any));
  const action = body.action;

  if (action === 'close_period') {
    const { expert_id, period_start, period_end, notes } = body;
    if (!expert_id || !period_start || !period_end) {
      return NextResponse.json({ error: 'expert_id, period_start, period_end required' }, { status: 400 });
    }

    // Pull expert's pay config + tz
    const { data: ex } = await (admin
      .from('profiles' as any) as any)
      .select('hourly_rate, target_tins_per_hour, iana_timezone, payment_method')
      .eq('id', expert_id)
      .single();
    const hourlyRate = Number(ex?.hourly_rate) || PAYROLL_DEFAULTS.HOURLY_RATE;
    const targetRate = Number(ex?.target_tins_per_hour) || PAYROLL_DEFAULTS.TARGET_TINS_PER_HOUR;
    const tz = ex?.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;

    const startIso = new Date(period_start).toISOString();
    const endExclusiveIso = new Date(new Date(period_end).getTime() + 24 * 3600 * 1000).toISOString();

    const { data: logs } = await (admin
      .from('expert_time_logs' as any) as any)
      .select('id, hours_worked, tins_completed, end_at')
      .eq('expert_id', expert_id)
      .gte('start_at', startIso)
      .lt('start_at', endExclusiveIso);

    let totalHours = 0;
    let totalTins = 0;
    for (const l of (logs || []) as any[]) {
      if (!l.end_at) continue; // skip open sessions
      totalHours += Number(l.hours_worked) || 0;
      totalTins += Number(l.tins_completed) || 0;
    }
    const totals = computeSessionTotals(totalHours, totalTins, hourlyRate, targetRate);

    const { data: completed } = await (admin
      .from('expert_assignments' as any) as any)
      .select('expert_clock_started_at, completed_at, sla_business_hours')
      .eq('expert_id', expert_id)
      .eq('status', 'completed')
      .gte('completed_at', startIso)
      .lt('completed_at', endExclusiveIso);
    const slaMetPct = computeSlaMetPct((completed as any) || [], tz);

    const payDate = new Date(new Date(period_end).getTime() + PAYROLL_DEFAULTS.PAY_DATE_LAG_DAYS * 24 * 3600 * 1000);

    const upsertRow = {
      expert_id,
      period_start,
      period_end,
      pay_date: payDate.toISOString().slice(0, 10),
      hourly_rate: hourlyRate,
      target_tins_per_hour: targetRate,
      total_hours: totals.hours,
      total_tins: totals.tinsCompleted,
      expected_tins: totals.expectedTins,
      efficiency_pct: totals.efficiencyPct,
      sla_met_pct: slaMetPct,
      gross_pay: totals.grossPay,
      status: 'approved',
      notes: (notes || '').trim() || null,
      updated_at: new Date().toISOString(),
    };

    const { data: upserted, error } = await (admin
      .from('expert_pay_periods' as any) as any)
      .upsert(upsertRow, { onConflict: 'expert_id,period_start,period_end' })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: 'Failed to close period', detail: error.message }, { status: 500 });

    // Stamp pay_period_id on contributing logs
    if (upserted?.id && logs) {
      await (admin.from('expert_time_logs' as any) as any)
        .update({ pay_period_id: upserted.id })
        .eq('expert_id', expert_id)
        .gte('start_at', startIso)
        .lt('start_at', endExclusiveIso);
    }

    return NextResponse.json({ success: true, action: 'close_period', period_id: upserted?.id, totals });
  }

  if (action === 'mark_paid') {
    const { period_id, payment_reference, notes } = body;
    if (!period_id) return NextResponse.json({ error: 'period_id required' }, { status: 400 });

    const { error } = await (admin
      .from('expert_pay_periods' as any) as any)
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        paid_by: user.id,
        payment_reference: (payment_reference || '').trim() || null,
        notes: notes ? notes.trim() : undefined, // keep existing if not provided
        updated_at: new Date().toISOString(),
      })
      .eq('id', period_id);
    if (error) return NextResponse.json({ error: 'Failed to mark paid', detail: error.message }, { status: 500 });

    await (admin.from('audit_log' as any) as any).insert({
      user_email: profile.email,
      action: 'settings_changed',
      entity_type: 'expert_pay_period',
      entity_id: period_id,
      details: { action: 'pay_period_marked_paid', payment_reference: payment_reference || null },
    });

    return NextResponse.json({ success: true, action: 'mark_paid', period_id });
  }

  if (action === 'edit_log') {
    const { log_id, hours_worked, tins_completed, notes } = body;
    if (!log_id) return NextResponse.json({ error: 'log_id required' }, { status: 400 });
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof hours_worked === 'number') update.hours_worked = hours_worked;
    if (typeof tins_completed === 'number') update.tins_completed = tins_completed;
    if (typeof notes === 'string') update.notes = notes;
    const { error } = await (admin.from('expert_time_logs' as any) as any).update(update).eq('id', log_id);
    if (error) return NextResponse.json({ error: 'Failed to edit log', detail: error.message }, { status: 500 });
    return NextResponse.json({ success: true, action: 'edit_log', log_id });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
