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
import { initiateCall as initiateCallViaProvider } from '@/lib/voice-provider';

const MAX_ENTITIES_PER_CALL = 3; // IRS processes each 8821 individually — 3 keeps call under 45 min
const DAILY_SPEND_CAP = parseFloat(process.env.BLAND_DAILY_SPEND_CAP || '50');

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role, full_name, caf_number, ptin, phone_number, fax_number, address')
      .eq('id', user.id)
      .single() as { data: any; error: any };

    if (profileError || !profile || profile.role !== 'expert') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Fetch optional columns separately — may not exist if migration not run yet
    const { data: extraFields } = await supabase
      .from('profiles')
      .select('sor_id, voice_sample_url')
      .eq('id', user.id)
      .single() as { data: any; error: any };

    const fullProfile = { ...profile, ...extraFields };

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

    // Check no active call exists for this expert.
    // .single() crashes when 2+ rows exist (PGRST116) — was previously
    // swallowed by the catch above, leaving the 409 logic dead. Use a
    // limit-1 select so we get the most recent active call cleanly even
    // when state cleanup left orphans.
    const { data: activeCalls } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, status, initiated_at')
      .eq('expert_id', user.id)
      .in('status', ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'])
      .order('initiated_at', { ascending: false })
      .limit(1) as { data: any[] | null; error: any };

    const activeCall = activeCalls?.[0];
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
      // Day-of-week check uses the SCHEDULED TIMEZONE (e.g., America/New_York)
      // not UTC. The previous getUTCDay() check rejected Friday 6pm PT calls
      // because they convert to Saturday 1am UTC — false positive.
      const tz = body.timezone || 'America/New_York';
      const dowName = scheduledDate.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
      if (dowName === 'Sat' || dowName === 'Sun') {
        return NextResponse.json({
          error: `IRS PPS is closed on weekends. Selected time is ${dowName} in ${tz}. Pick a weekday.`,
        }, { status: 400 });
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
        expert_sor_id: fullProfile.sor_id || null,
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

      // Calendar invite — send a .ics meeting invitation to the expert so the
      // scheduled call lands on their primary calendar with reminders + RSVP
      // buttons. Best-effort: scheduling shouldn't fail just because email did.
      // The same UID is reused across REQUEST/CANCEL/UPDATE so the calendar
      // event tracks updates instead of duplicating.
      try {
        const { buildIcsInvite, callSessionUid } = await import('@/lib/calendar-invite');
        const { sendCalendarInvite } = await import('@/lib/sendgrid');
        const startsAt = new Date(scheduledFor);
        const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000); // 60 min default
        const modeLabel =
          resolvedCallMode === 'ai_full' ? 'AI Full (no expert action needed)'
          : resolvedCallMode === 'irs_callback' ? 'IRS Callback (system bridges to your phone)'
          : 'Hold & Transfer (system holds, transfers to your phone when agent answers)';
        const consoleUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io'}/expert/call/${session.id}`;
        const entityList = entities.map(e =>
          `  • ${e.entity_name} — ${e.tid_kind} ${e.tid} — Form ${e.form_type} — Years ${(e.years || []).join(', ')}`,
        ).join('\n');
        const description = [
          `IRS Practitioner Priority Service call for ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}.`,
          '',
          `Mode: ${modeLabel}`,
          resolvedCallbackPhone ? `Your phone: ${resolvedCallbackPhone}` : '',
          `CAF: ${profile.caf_number}`,
          '',
          'Entities on this call:',
          entityList,
          '',
          `Open the call console when it's time:`,
          consoleUrl,
        ].filter(Boolean).join('\n');

        const expertEmail = user.email;
        if (expertEmail) {
          const ics = buildIcsInvite({
            uid: callSessionUid(session.id),
            sequence: 0,
            method: 'REQUEST',
            startsAt,
            endsAt,
            summary: `IRS PPS Call — ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}`,
            description,
            location: resolvedCallMode === 'ai_full' ? consoleUrl : (resolvedCallbackPhone || consoleUrl),
            organizer: { email: process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io', name: 'ModernTax' },
            attendee: { email: expertEmail, name: profile.full_name || undefined },
            url: consoleUrl,
          });

          // Plain HTML preamble — gives Gmail something to show even before
          // the inline calendar card renders. Keep short — the calendar
          // event itself carries the detail.
          const htmlPreamble = `
<div style="font-family: system-ui, -apple-system, sans-serif; color: #13213e;">
  <h2 style="color:#13213e;margin:0 0 8px;">IRS PPS Call scheduled</h2>
  <p style="margin:4px 0;">${startsAt.toLocaleString('en-US', { timeZone: timezone || 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })} (${timezone || 'America/Los_Angeles'})</p>
  <p style="margin:4px 0;color:#666;">${entities.length} ${entities.length === 1 ? 'entity' : 'entities'} · Mode: ${modeLabel}</p>
  <p style="margin:12px 0;"><a href="${consoleUrl}" style="color:#00C48C;font-weight:600;">Open the call console →</a></p>
  <p style="margin:4px 0;color:#888;font-size:12px;">Add this to your calendar by accepting the invite below. We'll send a 15-minute reminder.</p>
</div>`;

          await sendCalendarInvite({
            to: { email: expertEmail, name: profile.full_name || undefined },
            subject: `IRS PPS Call — ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'} on ${startsAt.toLocaleDateString('en-US', { timeZone: timezone || 'America/Los_Angeles', dateStyle: 'medium' })}`,
            htmlPreamble,
            ics,
            method: 'REQUEST',
            cc: ['matt@moderntax.io'],
          });
          console.log(`[irs-call/initiate] Calendar invite sent to ${expertEmail} for session ${session.id}`);
        }
      } catch (inviteErr) {
        // Best-effort — never block the schedule on email failures.
        console.error('[irs-call/initiate] Failed to send calendar invite:', inviteErr);
      }

      // INLINE-FIRE optimization: when the expert schedules a call within the
      // next 5 minutes (e.g., "fire in 2 min"), don't wait for the next cron
      // sweep — fire it immediately and update the response so the UI shows
      // status='ringing' instead of 'scheduled'. Cron + inline-fire are race-
      // safe because fireScheduledCall does an atomic status='scheduled'→
      // 'initiating' lock before doing anything else.
      const gapMs = new Date(scheduledFor).getTime() - Date.now();
      const INLINE_THRESHOLD_MS = 5 * 60 * 1000;
      if (gapMs <= INLINE_THRESHOLD_MS) {
        try {
          const { fireScheduledCall } = await import('@/lib/fire-call');
          const r = await fireScheduledCall(adminSupabase as any, session.id);
          console.log(`[irs-call/initiate] Inline-fired session ${session.id} (${Math.round(gapMs / 1000)}s gap) via ${r.provider}: ${r.call_id}`);
          return NextResponse.json({
            success: true,
            sessionId: session.id,
            entityCount: entities.length,
            status: 'ringing',
            firedInline: true,
            callId: r.call_id,
            provider: r.provider,
            scheduledFor,
            calendarInviteSent: !!user.email,
          });
        } catch (fireErr) {
          // If inline fire fails, fall through to the normal scheduled response —
          // the cron will retry on next sweep. This way an inline fire failure
          // doesn't break the schedule confirmation.
          console.error(`[irs-call/initiate] Inline fire failed, falling back to cron: ${fireErr instanceof Error ? fireErr.message : fireErr}`);
        }
      }

      return NextResponse.json({
        success: true,
        sessionId: session.id,
        entityCount: entities.length,
        status: 'scheduled',
        scheduledFor,
        calendarInviteSent: !!user.email,
      });
    }

    // Immediate call — fire via active provider (bland or retell).
    // The voice-provider router stores the call_id in the same `bland_call_id`
    // column regardless of provider — downstream code uses providerForCallId()
    // to detect which API to call for stop/status/listen.
    try {
      const blandResponse = await initiateCallViaProvider({
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
          address: e.address || undefined,
        })),
        metadata: {
          sessionId: session.id,
          expertId: user.id,
          assignmentIds,
        },
        sorInbox: fullProfile.sor_id || undefined,
        voiceSampleUrl: fullProfile.voice_sample_url || undefined,
        callMode: resolvedCallMode as 'ai_full' | 'hold_and_transfer' | 'irs_callback',
        callbackPhone: resolvedCallbackPhone || undefined,
      });

      console.log(`[irs-call/initiate] provider=${blandResponse.provider} call_id=${blandResponse.call_id}`);

      // Update session with call ID + from_number (MOD-211 retry chain).
      // We still use the `bland_call_id` column for both providers — it's
      // just a text field storing whichever id the active provider
      // returned. Retell call_ids start with "call_" so we can detect
      // provider downstream without a schema migration.
      const sessionPatch: Record<string, unknown> = {
        bland_call_id: blandResponse.call_id,
        status: 'ringing',
      };
      if (blandResponse.from_number) sessionPatch.from_number = blandResponse.from_number;
      await adminSupabase
        .from('irs_call_sessions' as any)
        .update(sessionPatch)
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

      // Mark the entities as actively being worked. 'processing' was a valid
      // status in the schema but nothing ever wrote it, so the stuck-entity and
      // processor-delay crons that key on it never fired — an in-flight call
      // looked identical to an untouched queue item. Firing the call is the
      // authoritative "work started" signal. Guarded on 'irs_queue' so a
      // completed/failed entity is never regressed; completion (upload-transcript)
      // keys on assignment status, so it still advances from 'processing'.
      await adminSupabase
        .from('request_entities')
        .update({ status: 'processing' })
        .in('id', entityIds)
        .eq('status', 'irs_queue');

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
