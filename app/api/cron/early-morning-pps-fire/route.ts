/**
 * GET /api/cron/early-morning-pps-fire
 *
 * Friday 2026-05-22 at 11:00 UTC (4am PT / 7am ET — opening minute of the
 * IRS Practitioner Priority Service line on the East Coast). Fires a
 * Bland PPS call for the iCloud expert's open queue to catch the fresh
 * zero-wait window before the post-Memorial-Day Tuesday crowd hits.
 *
 * Date-guarded to a single Friday so the cron entry in vercel.json can
 * sit at `0 11 * * 5` indefinitely without spurious fires.
 *
 * Behavior:
 *  1. Verify Bland has positive balance (was -$1.10 yesterday — without
 *     this we'd silent-fail with 402)
 *  2. Find iCloud expert's open assignments (status=assigned/in_progress,
 *     entity status=irs_queue, has signed_8821_url)
 *  3. Fire ONE Bland call attempting hold_and_transfer first (since the
 *     queue should be empty); IRS will likely connect live within ~30s.
 *     Falls back to irs_callback mode if hold_and_transfer rejected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TARGET_DATE_UTC = '2026-05-22';
const ICLOUD_EXPERT_ID = 'bd374d60-5146-4ca9-90e6-29af28af641f';
const EXPERT_CALLBACK_PHONE = '6507411085';

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const todayUtc = new Date().toISOString().slice(0, 10);
  if (todayUtc !== TARGET_DATE_UTC) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: `Today (${todayUtc}) is not the target Friday (${TARGET_DATE_UTC}). Endpoint is one-shot.`,
    });
  }

  // 1. Bland balance pre-check
  const blandKey = process.env.BLAND_API_KEY;
  if (!blandKey) {
    return NextResponse.json({ error: 'BLAND_API_KEY missing' }, { status: 500 });
  }
  try {
    const meRes = await fetch('https://api.bland.ai/v1/me', {
      headers: { authorization: blandKey },
    });
    const meBody = await meRes.json();
    const balance = Number(meBody?.billing?.current_balance ?? 0);
    if (balance <= 1) {
      return NextResponse.json({
        success: false,
        skipped: true,
        reason: `Bland balance is $${balance.toFixed(2)} — refusing to fire to avoid 402 cascade. Top up at app.bland.ai then re-fire manually.`,
        balance,
      }, { status: 402 });
    }
  } catch (err) {
    return NextResponse.json({ error: 'Bland balance check failed', detail: String(err) }, { status: 502 });
  }

  // 2. Discover iCloud expert's open queue
  const sb = createAdminClient();
  const { data: assignments } = await sb
    .from('expert_assignments')
    .select('id, entity_id, request_entities!inner(id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, status)')
    .eq('expert_id', ICLOUD_EXPERT_ID)
    .in('status', ['assigned', 'in_progress'])
    .eq('request_entities.status', 'irs_queue')
    .not('request_entities.signed_8821_url', 'is', null)
    .limit(5) as { data: any[] | null };

  if (!assignments || assignments.length === 0) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'No open irs_queue assignments for iCloud expert',
    });
  }

  // 3. Fire ONE call — irs_callback mode since the expert won't be at desk at 4am PT.
  //    The IRS queue is empty at this hour so callback ETA should be minutes, not hours.
  //    The expert wakes up around 5-6am PT and the callback comes in for him to take.
  let initiateCall: any;
  try {
    initiateCall = (await import('@/lib/bland')).initiateCall;
  } catch (err) {
    return NextResponse.json({ error: 'Failed to load Bland lib', detail: String(err) }, { status: 500 });
  }

  // Look up the iCloud expert credentials for the call
  const { data: expertProfile } = await sb.from('profiles')
    .select('full_name, caf_number, fax_number')
    .eq('id', ICLOUD_EXPERT_ID).single() as { data: any };

  const callParams = {
    expertName: expertProfile?.full_name || 'Matthew Parker, C/O ModernTax, Inc.',
    cafNumber: expertProfile?.caf_number || '0316-30210R',
    expertFax: expertProfile?.fax_number || '415-900-4436',
    expertPhone: EXPERT_CALLBACK_PHONE,
    callbackPhone: EXPERT_CALLBACK_PHONE,
    callMode: 'irs_callback' as const,
    entities: assignments.map((a: any) => ({
      taxpayerName: a.request_entities.entity_name,
      taxpayerTid: a.request_entities.tid,
      tidKind: a.request_entities.tid_kind || (/^\d{3}-?\d{2}-?\d{4}$/.test(a.request_entities.tid || '') ? 'SSN' : 'EIN'),
      formType: a.request_entities.form_type,
      years: a.request_entities.years || [],
      entityId: a.entity_id,
      signed8821Url: a.request_entities.signed_8821_url,
    })),
    metadata: { source: 'early-morning-pps-fire-2026-05-22' },
  };

  try {
    const call = await initiateCall(callParams);
    // Log a kickoff record in irs_call_sessions so the dashboard reflects it
    await sb.from('irs_call_sessions').insert({
      expert_id: ICLOUD_EXPERT_ID,
      bland_call_id: call.call_id,
      status: 'ringing',
      scheduled_for: new Date().toISOString(),
      scheduled_timezone: 'America/Los_Angeles',
      caf_number: callParams.cafNumber,
      expert_name: callParams.expertName,
      expert_fax: callParams.expertFax,
      expert_sor_id: 'MPARKER31',
      callback_phone: EXPERT_CALLBACK_PHONE,
      callback_mode: 'irs_callback',
      callback_status: 'waiting',
      initiated_at: new Date().toISOString(),
    } as any);
    return NextResponse.json({
      success: true,
      call_id: call.call_id,
      provider: call.provider,
      from_number: call.from_number,
      entities: assignments.map((a: any) => a.request_entities.entity_name),
    });
  } catch (err) {
    return NextResponse.json({ error: 'Bland call placement failed', detail: String(err) }, { status: 502 });
  }
}
