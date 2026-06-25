/**
 * Expert self-serve payouts.
 *
 * GET  /api/expert/payouts
 *   Returns the logged-in expert's pay schedule, current-period earnings (live
 *   from their own expert_time_logs), recent pay periods, payment method, and
 *   W-9 status. Read-only; scoped strictly to the caller.
 *
 * POST /api/expert/payouts  (multipart: file=<signed W-9 PDF>)
 *   Stores the expert's signed W-9 and stamps profiles.w9_url / w9_uploaded_at.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { PAYROLL_DEFAULTS, payPeriodFor, computeSessionTotals } from '@/lib/expert-payroll';

export const runtime = 'nodejs';

async function authedExpert() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) } as const;
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, full_name, email, hourly_rate, target_tins_per_hour, payment_method, w9_url, w9_uploaded_at')
    .eq('id', user.id).single() as { data: any };
  if (!profile || profile.role !== 'expert') {
    return { error: NextResponse.json({ error: 'Expert only' }, { status: 403 }) } as const;
  }
  return { user, profile } as const;
}

export async function GET() {
  const a = await authedExpert();
  if ('error' in a) return a.error;
  const { profile } = a;
  const admin = createAdminClient();

  const hourlyRate = Number(profile.hourly_rate) || PAYROLL_DEFAULTS.HOURLY_RATE;
  const targetRate = Number(profile.target_tins_per_hour) || PAYROLL_DEFAULTS.TARGET_TINS_PER_HOUR;
  const now = new Date();
  const { periodStart, periodEnd, payDate } = payPeriodFor(now);

  // Current-period earnings from this expert's own (closed) time logs.
  const { data: logs } = await admin
    .from('expert_time_logs')
    .select('hours_worked, tins_completed, end_at, start_at')
    .eq('expert_id', profile.id)
    .gte('start_at', periodStart.toISOString())
    .lte('start_at', new Date(periodEnd.getTime() + 24 * 3600 * 1000).toISOString()) as { data: any[] | null };
  let hours = 0, tins = 0;
  for (const l of logs || []) {
    if (!l.end_at) continue; // open shift — not counted until closed
    hours += Number(l.hours_worked) || 0;
    tins += Number(l.tins_completed) || 0;
  }
  const current = computeSessionTotals(hours, tins, hourlyRate, targetRate);

  // Recent pay periods (approved / paid history).
  const { data: periods } = await admin
    .from('expert_pay_periods')
    .select('*')
    .eq('expert_id', profile.id)
    .order('period_end', { ascending: false })
    .limit(8) as { data: any[] | null };

  return NextResponse.json({
    expert_name: profile.full_name || profile.email,
    hourly_rate: hourlyRate,
    payment_method: profile.payment_method || null,
    pay_schedule: {
      cadence: 'bi-weekly',
      period_days: PAYROLL_DEFAULTS.PAY_PERIOD_DAYS,
      pay_lag_days: PAYROLL_DEFAULTS.PAY_DATE_LAG_DAYS,
      current_period_start: periodStart.toISOString().slice(0, 10),
      current_period_end: periodEnd.toISOString().slice(0, 10),
      current_pay_date: payDate.toISOString().slice(0, 10),
    },
    current_period: {
      hours: current.hours,
      tins_completed: current.tinsCompleted,
      gross_pay: current.grossPay,
    },
    periods: (periods || []).map((p: any) => ({
      period_start: p.period_start,
      period_end: p.period_end,
      pay_date: p.pay_date,
      gross_pay: Number(p.gross_pay) || 0,
      status: p.status,
      paid_at: p.paid_at,
      payment_reference: p.payment_reference,
    })),
    w9: {
      on_file: !!profile.w9_url,
      uploaded_at: profile.w9_uploaded_at || null,
      blank_form_url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    },
  });
}

export async function POST(request: NextRequest) {
  const a = await authedExpert();
  if ('error' in a) return a.error;
  const { profile } = a;
  const admin = createAdminClient();

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Attach your signed W-9 (PDF)' }, { status: 400 });
  }
  if (file.type && file.type !== 'application/pdf') {
    return NextResponse.json({ error: 'W-9 must be a PDF' }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const path = `${profile.id}/w9/${Date.now()}-w9.pdf`;
  const { error: upErr } = await admin.storage.from('uploads').upload(path, buffer, {
    contentType: 'application/pdf', upsert: true,
  });
  if (upErr) return NextResponse.json({ error: 'Upload failed', detail: upErr.message }, { status: 500 });

  const { error: updErr } = await (admin.from('profiles' as any) as any)
    .update({ w9_url: path, w9_uploaded_at: new Date().toISOString() })
    .eq('id', profile.id);
  if (updErr) return NextResponse.json({ error: 'Failed to record W-9', detail: updErr.message }, { status: 500 });

  return NextResponse.json({ success: true, uploaded_at: new Date().toISOString() });
}
