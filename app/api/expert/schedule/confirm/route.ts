/**
 * Confirm Schedule
 * POST — Expert confirms a time slot. Creates a scheduled IRS call session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { zonedWallClockToUtc } from '@/lib/expert-sla';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, time, callMode, callbackPhone } = body;

    if (!token || !time) {
      return NextResponse.json({ error: 'Token and time are required' }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Verify token
    const { data: schedule, error: tokenErr } = await supabase
      .from('expert_schedule_tokens' as any)
      .select('*')
      .eq('token', token)
      .eq('status', 'pending')
      .single() as { data: any; error: any };

    if (tokenErr || !schedule) {
      return NextResponse.json({ error: 'This link has expired or already been used.' }, { status: 404 });
    }

    // Verify date is today
    const today = new Date().toISOString().split('T')[0];
    if (schedule.schedule_date !== today) {
      return NextResponse.json({ error: 'This schedule link has expired.' }, { status: 410 });
    }

    // Get expert profile
    // iana_timezone isn't in the generated types yet; cast to keep inference.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, caf_number, phone_number, fax_number, iana_timezone')
      .eq('id', schedule.expert_id)
      .single() as { data: any };

    if (!profile || !profile.caf_number) {
      return NextResponse.json({ error: 'Expert profile incomplete' }, { status: 400 });
    }

    const effectivePhone = callbackPhone || profile.phone_number;
    const effectiveMode = callMode || 'hold_and_transfer';
    const callbackModeDb = effectiveMode === 'irs_callback' ? 'irs_callback' : 'transfer';

    if (effectiveMode !== 'ai_full' && !effectivePhone) {
      return NextResponse.json({ error: 'Phone number required for callback/transfer' }, { status: 400 });
    }

    // Build scheduled_for: today at the selected time, interpreted in the
    // EXPERT'S timezone. The old code hardcoded -04:00 (EDT), which (a) broke
    // in EST months (Nov–Mar → -05:00) and (b) treated every expert's picked
    // time as ET — so a PT expert who chose "10:00" was scheduled for 10:00 ET
    // (7:00 AM PT) and missed the IRS callback. (MOD-204)
    const expertTz = profile.iana_timezone || 'America/New_York';
    const scheduledFor = zonedWallClockToUtc(today, time, expertTz).toISOString();

    // Get pending assignments
    const { data: assignments } = await supabase
      .from('expert_assignments')
      .select('id, entity_id, request_entities(id, entity_name, tid, tid_kind, form_type, years)')
      .eq('expert_id', schedule.expert_id)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null };

    if (!assignments || assignments.length === 0) {
      return NextResponse.json({ error: 'No pending assignments found' }, { status: 400 });
    }

    // Batch into groups of 5
    const batches: any[][] = [];
    for (let i = 0; i < assignments.length; i += 5) {
      batches.push(assignments.slice(i, i + 5));
    }

    const sessionIds: string[] = [];

    for (const batch of batches) {
      // Create call session
      const { data: session, error: sessErr } = await supabase
        .from('irs_call_sessions' as any)
        .insert({
          expert_id: schedule.expert_id,
          status: 'scheduled',
          scheduled_for: scheduledFor,
          scheduled_timezone: 'America/New_York',
          caf_number: profile.caf_number,
          expert_name: profile.full_name,
          expert_fax: profile.fax_number || null,
          callback_phone: effectivePhone,
          callback_mode: callbackModeDb,
          callback_status: 'waiting',
          cost_per_minute: 0.09,
        })
        .select('id')
        .single() as { data: any; error: any };

      if (sessErr || !session) {
        console.error('Failed to create call session:', sessErr);
        continue;
      }

      sessionIds.push(session.id);

      // Create call entities
      for (const asn of batch) {
        const entity = asn.request_entities;
        await supabase.from('irs_call_entities' as any).insert({
          call_session_id: session.id,
          assignment_id: asn.id,
          entity_id: asn.entity_id,
          taxpayer_name: entity.entity_name,
          taxpayer_tid: entity.tid,
          form_type: entity.form_type,
          tax_years: entity.years,
        });
      }
    }

    // Mark token as used
    await supabase
      .from('expert_schedule_tokens' as any)
      .update({
        status: 'confirmed',
        confirmed_time: time,
        confirmed_mode: effectiveMode,
        call_session_id: sessionIds[0] || null,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', schedule.id);

    return NextResponse.json({
      success: true,
      callbackPhone: effectivePhone,
      entityCount: assignments.length,
      sessionCount: sessionIds.length,
      scheduledFor,
    });
  } catch (error) {
    console.error('Schedule confirm error:', error);
    return NextResponse.json({ error: 'Failed to schedule call' }, { status: 500 });
  }
}
