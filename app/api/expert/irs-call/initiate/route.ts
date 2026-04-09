/**
 * IRS PPS Call Initiation
 * POST — Start a multi-entity IRS PPS call via Bland AI
 *
 * Expert selects up to 5 assignments, system builds persona + task prompt,
 * Bland AI calls IRS, navigates phone tree, speaks as the expert.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { initiateCall } from '@/lib/bland';

const MAX_ENTITIES_PER_CALL = 5;
const DAILY_SPEND_CAP = parseFloat(process.env.BLAND_DAILY_SPEND_CAP || '50');

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name, caf_number, ptin, phone_number, fax_number, address')
      .eq('id', user.id)
      .single() as { data: any; error: any };

    if (!profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { assignmentIds, scheduledFor, timezone, callMode, callbackPhone } = body;
    // scheduledFor: ISO string like "2026-04-07T14:00:00Z" (optional — null = call now)
    // timezone: e.g. "America/New_York" (for IRS hours validation)
    // callMode: 'ai_full' | 'hold_and_transfer' | 'irs_callback' (default: 'hold_and_transfer')
    // callbackPhone: expert's personal phone for transfer (uses profile phone if not provided)

    if (!assignmentIds || !Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      return NextResponse.json({ error: 'assignmentIds array is required' }, { status: 400 });
    }

    if (assignmentIds.length > MAX_ENTITIES_PER_CALL) {
      return NextResponse.json({ error: `Maximum ${MAX_ENTITIES_PER_CALL} entities per call` }, { status: 400 });
    }

    // Validate expert credentials
    if (!profile.caf_number) {
      return NextResponse.json({ error: 'CAF number required. Update your profile first.' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Check no active call exists for this expert
    const { data: activeCall } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, status')
      .eq('expert_id', user.id)
      .in('status', ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'])
      .single() as { data: any; error: any };

    if (activeCall) {
      return NextResponse.json({
        error: 'You already have an active IRS call',
        activeCallId: activeCall.id,
        activeCallStatus: activeCall.status,
      }, { status: 409 });
    }

    // Check daily spend cap
    const today = new Date().toISOString().split('T')[0];
    const { data: todaysCalls } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('estimated_cost')
      .eq('expert_id', user.id)
      .gte('initiated_at', `${today}T00:00:00Z`) as { data: any[]; error: any };

    const dailySpend = (todaysCalls || []).reduce(
      (sum: number, c: any) => sum + (parseFloat(c.estimated_cost) || 0), 0
    );

    if (dailySpend >= DAILY_SPEND_CAP) {
      return NextResponse.json({
        error: `Daily spend cap reached ($${DAILY_SPEND_CAP}). Contact admin.`,
        dailySpend,
      }, { status: 429 });
    }

    // Verify expert owns all assignments and they're in valid status
    const { data: assignments, error: assignError } = await adminSupabase
      .from('expert_assignments')
      .select('id, expert_id, status, entity_id')
      .in('id', assignmentIds);

    if (assignError || !assignments) {
      return NextResponse.json({ error: 'Failed to fetch assignments' }, { status: 500 });
    }

    if (assignments.length !== assignmentIds.length) {
      return NextResponse.json({ error: 'One or more assignments not found' }, { status: 404 });
    }

    for (const a of assignments) {
      if (a.expert_id !== user.id) {
        return NextResponse.json({ error: 'Not authorized for one or more assignments' }, { status: 403 });
      }
      if (!['assigned', 'in_progress'].includes(a.status)) {
        return NextResponse.json({ error: `Assignment ${a.id} is not in a callable status (${a.status})` }, { status: 400 });
      }
    }

    // Fetch entity data for all assignments
    const entityIds = assignments.map(a => a.entity_id);
    const { data: entities, error: entityError } = await adminSupabase
      .from('request_entities')
      .select('id, entity_name, tid, tid_kind, form_type, years, signed_8821_url, address, city, state, zip_code')
      .in('id', entityIds);

    if (entityError || !entities) {
      return NextResponse.json({ error: 'Failed to fetch entity data' }, { status: 500 });
    }

    // Build entity map for quick lookup
    const entityMap = new Map(entities.map(e => [e.id, e]));

    // Determine if this is a scheduled call or immediate
    const isScheduled = !!scheduledFor;
    const initialStatus = isScheduled ? 'scheduled' : 'initiating';

    // Validate scheduled time is during IRS PPS hours (7am-7pm local)
    if (isScheduled) {
      const scheduledDate = new Date(scheduledFor);
      if (isNaN(scheduledDate.getTime())) {
        return NextResponse.json({ error: 'Invalid scheduledFor date' }, { status: 400 });
      }
      // Basic validation: must be in the future
      if (scheduledDate <= new Date()) {
        return NextResponse.json({ error: 'Scheduled time must be in the future' }, { status: 400 });
      }
      // Check day of week (Mon-Fri only, IRS is closed weekends)
      const dayOfWeek = scheduledDate.getUTCDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return NextResponse.json({ error: 'IRS PPS is closed on weekends. Select a weekday.' }, { status: 400 });
      }
    }

    // Determine call mode — default to hold_and_transfer (expert takes over when agent answers)
    const resolvedCallMode = callMode || 'hold_and_transfer';
    const resolvedCallbackPhone = callbackPhone || profile.phone_number || null;

    // Validate callback phone for transfer/callback modes
    if (resolvedCallMode !== 'ai_full' && !resolvedCallbackPhone) {
      return NextResponse.json({
        error: 'Phone number required for call transfer. Update your profile with a phone number.',
      }, { status: 400 });
    }

    // Create call session
    const { data: session, error: sessionError } = await adminSupabase
      .from('irs_call_sessions' as any)
      .insert({
        expert_id: user.id,
        status: initialStatus,
        caf_number: profile.caf_number,
        expert_name: profile.full_name || user.email,
        expert_fax: profile.fax_number,
        expert_sor_id: profile.sor_id || null,
        scheduled_for: isScheduled ? scheduledFor : null,
        scheduled_timezone: timezone || 'America/Los_Angeles',
        callback_phone: resolvedCallbackPhone,
        callback_mode: resolvedCallMode === 'ai_full' ? null : resolvedCallMode === 'irs_callback' ? 'irs_callback' : 'transfer',
        callback_status: resolvedCallMode === 'ai_full' ? null : 'waiting',
      })
      .select()
      .single() as { data: any; error: any };

    if (sessionError || !session) {
      console.error('Failed to create call session:', sessionError);
      return NextResponse.json({ error: 'Failed to create call session' }, { status: 500 });
    }

    // Create call entity rows
    const callEntities = assignments.map(a => {
      const entity = entityMap.get(a.entity_id)!;
      return {
        call_session_id: session.id,
        assignment_id: a.id,
        entity_id: a.entity_id,
        taxpayer_tid: entity.tid,
        taxpayer_name: entity.entity_name,
        form_type: entity.form_type,
        tax_years: entity.years,
      };
    });

    const { error: entitiesInsertError } = await adminSupabase
      .from('irs_call_entities' as any)
      .insert(callEntities);

    if (entitiesInsertError) {
      console.error('Failed to create call entities:', entitiesInsertError);
      // Clean up session
      await adminSupabase.from('irs_call_sessions' as any).delete().eq('id', session.id);
      return NextResponse.json({ error: 'Failed to create call entities' }, { status: 500 });
    }

    // If scheduled, just save and return — cron will fire the call later
    if (isScheduled) {
      await logAuditFromRequest(adminSupabase, request, {
        action: 'irs_call_initiated',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'irs_call_session',
        resourceId: session.id,
        details: {
          scheduled_for: scheduledFor,
          timezone: timezone || 'America/Los_Angeles',
          entity_count: entities.length,
          entity_names: entities.map(e => e.entity_name),
          caf_number: profile.caf_number,
        },
      });

      return NextResponse.json({
        success: true,
        sessionId: session.id,
        entityCount: entities.length,
        status: 'scheduled',
        scheduledFor,
      });
    }

    // Immediate call — fire Bland AI now
    try {
      const blandResponse = await initiateCall({
        expertName: profile.full_name || user.email!,
        cafNumber: profile.caf_number,
        expertFax: profile.fax_number || undefined,
        expertPhone: profile.phone_number || undefined,
        expertAddress: profile.address || undefined,
        entities: entities.map(e => ({
          entityId: e.id,
          taxpayerName: e.entity_name,
          taxpayerTid: e.tid,
          tidKind: e.tid_kind as 'SSN' | 'EIN',
          formType: e.form_type,
          years: e.years,
        })),
        metadata: {
          sessionId: session.id,
          expertId: user.id,
          assignmentIds,
        },
        callMode: resolvedCallMode as 'ai_full' | 'hold_and_transfer' | 'irs_callback',
        callbackPhone: resolvedCallbackPhone || undefined,
      });

      // Update session with Bland call ID
      await adminSupabase
        .from('irs_call_sessions' as any)
        .update({
          bland_call_id: blandResponse.call_id,
          status: 'ringing',
        })
        .eq('id', session.id);

      // Transition assignments to in_progress
      for (const a of assignments) {
        if (a.status === 'assigned') {
          await adminSupabase
            .from('expert_assignments')
            .update({ status: 'in_progress' })
            .eq('id', a.id);
        }
      }

      await logAuditFromRequest(adminSupabase, request, {
        action: 'irs_call_initiated',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'irs_call_session',
        resourceId: session.id,
        details: {
          bland_call_id: blandResponse.call_id,
          entity_count: entities.length,
          entity_names: entities.map(e => e.entity_name),
          caf_number: profile.caf_number,
        },
      });

      return NextResponse.json({
        success: true,
        sessionId: session.id,
        blandCallId: blandResponse.call_id,
        entityCount: entities.length,
        status: 'ringing',
      });
    } catch (blandError) {
      console.error('Bland AI call failed:', blandError);

      // Update session to failed
      await adminSupabase
        .from('irs_call_sessions' as any)
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          error_message: blandError instanceof Error ? blandError.message : 'Unknown Bland AI error',
        })
        .eq('id', session.id);

      return NextResponse.json({
        error: 'Failed to initiate IRS call',
        details: blandError instanceof Error ? blandError.message : 'Unknown error',
        sessionId: session.id,
      }, { status: 502 });
    }
  } catch (error) {
    console.error('IRS call initiate error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
