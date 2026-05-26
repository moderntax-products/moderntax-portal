/**
 * POST /api/admin/pps-quick-call
 *
 * Admin manual-fire endpoint for IRS PPS callback calls — lets admin
 * pick a specific expert + TZ pool entry (ET / CT / MT / PT) when the
 * default picker's choice is dead.
 *
 * Driver: 2026-05-26 — Matt + Joel both hitting overflow_rejected on
 * every PT-originated call to IRS PPS Business line. Theory: forcing ET
 * routing may land in a different regional IRS queue. The autodial loop
 * doesn't expose TZ override; this endpoint does, from the admin UI.
 *
 * Body:
 *   { expertId: string, forceTz?: 'ET'|'CT'|'MT'|'PT'|null,
 *     callbackPhone?: string  // override expert's profile.phone if needed }
 *
 * Auto-pulls the expert's currently callable assignments (irs_queue +
 * signed_8821), creates an irs_call_sessions row + irs_call_entities
 * children, fires via fireScheduledCall with the forced TZ.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { fireScheduledCall } from '@/lib/fire-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VALID_TZS = ['ET', 'CT', 'MT', 'PT'];

export async function POST(request: NextRequest) {
  try {
    return await handle(request);
  } catch (err: any) {
    console.error('[pps-quick-call]', err);
    return NextResponse.json({
      error: 'Server error firing PPS call',
      detail: err?.message || String(err),
    }, { status: 500 });
  }
}

async function handle(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: callerProfile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { expertId?: string; forceTz?: string; callbackPhone?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const expertId = body.expertId?.trim();
  if (!expertId) return NextResponse.json({ error: 'expertId required' }, { status: 400 });
  const forceTz = body.forceTz && VALID_TZS.includes(body.forceTz.toUpperCase()) ? body.forceTz.toUpperCase() : null;

  const admin = createAdminClient();

  // Pull expert profile + callable assignments
  const { data: expert } = await admin.from('profiles')
    .select('id, role, full_name, caf_number, phone_number, fax_number, sor_id, address')
    .eq('id', expertId).single() as { data: any };
  if (!expert) return NextResponse.json({ error: 'Expert not found' }, { status: 404 });
  if (expert.role !== 'expert' && expert.role !== 'admin') {
    return NextResponse.json({ error: `User role=${expert.role}` }, { status: 400 });
  }

  const { data: assignments } = await admin.from('expert_assignments')
    .select(`id, entity_id, request_entities!inner(id, entity_name, tid, tid_kind, form_type, years, status, signed_8821_url)`)
    .eq('expert_id', expert.id)
    .in('status', ['assigned', 'in_progress'])
    .eq('request_entities.status', 'irs_queue')
    .not('request_entities.signed_8821_url', 'is', null)
    .order('assigned_at', { ascending: true })
    .limit(5) as { data: any[] };
  if (!assignments || assignments.length === 0) {
    return NextResponse.json({
      error: `${expert.full_name || 'Expert'} has no callable assignments (need status=irs_queue + signed 8821)`,
    }, { status: 422 });
  }

  const callbackPhone = (body.callbackPhone?.trim()) || expert.phone_number;
  if (!callbackPhone) {
    return NextResponse.json({ error: 'callbackPhone or expert profile.phone_number required' }, { status: 422 });
  }

  // Create session
  const { data: session, error: sErr } = await admin.from('irs_call_sessions' as any)
    .insert({
      expert_id: expert.id,
      status: 'scheduled',
      caf_number: expert.caf_number || '',
      expert_name: expert.full_name || expertId,
      expert_fax: expert.fax_number || '',
      expert_sor_id: expert.sor_id || '',
      scheduled_for: new Date().toISOString(),
      scheduled_timezone: 'America/Los_Angeles',
      callback_phone: callbackPhone.replace(/\D/g, ''),
      callback_mode: 'irs_callback',
      callback_status: 'waiting',
    })
    .select('id').single() as { data: any; error: any };
  if (sErr || !session) {
    return NextResponse.json({ error: 'Failed to create session', detail: sErr?.message }, { status: 500 });
  }

  // Attach entities
  await admin.from('irs_call_entities' as any).insert(assignments.map((a: any) => ({
    call_session_id: session.id,
    assignment_id: a.id,
    entity_id: a.entity_id,
    taxpayer_tid: a.request_entities.tid,
    taxpayer_name: a.request_entities.entity_name,
    form_type: a.request_entities.form_type,
    tax_years: a.request_entities.years,
  })) as any);

  // Fire with TZ override
  let result;
  try {
    result = await fireScheduledCall(admin as any, session.id, { forceFromTz: forceTz });
  } catch (err: any) {
    return NextResponse.json({
      error: 'Fire failed',
      detail: err?.message || String(err),
      session_id: session.id,
    }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    session_id: session.id,
    provider: result.provider,
    provider_call_id: result.call_id,
    from_number: result.from_number,
    forced_tz: forceTz,
    expert_name: expert.full_name,
    entities_attached: assignments.length,
    entity_names: assignments.map((a: any) => a.request_entities.entity_name),
  });
}
