/**
 * IRS Call Cancel
 * POST — Cancel an active IRS PPS call
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { stopCall as stopCallViaProvider, getCallStatus as getCallStatusViaProvider, providerForCallId } from '@/lib/voice-provider';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || !['expert', 'admin'].includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, expert_name, bland_call_id, status, initiated_at, scheduled_for, scheduled_timezone, cost_per_minute')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (profile.role !== 'admin' && session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Cancellable states fall into two buckets:
    //   1. ACTIVE calls   — must stop the provider call, fetch transcript/recording.
    //   2. SCHEDULED calls — no provider call yet, just mark cancelled + send
    //                        CANCEL ics to release the expert's calendar block.
    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    const scheduledStatuses = ['scheduled'];
    const isScheduledCancel = scheduledStatuses.includes(session.status);
    if (!activeStatuses.includes(session.status) && !isScheduledCancel) {
      return NextResponse.json({ error: 'Call is not active or scheduled' }, { status: 400 });
    }

    // Scheduled-call short-circuit: no Bland call to stop, no transcript to fetch.
    // Just flip status + send the calendar cancellation, then return.
    if (isScheduledCancel) {
      await adminSupabase
        .from('irs_call_sessions' as any)
        .update({ status: 'cancelled', ended_at: new Date().toISOString() })
        .eq('id', sessionId);

      await adminSupabase
        .from('irs_call_entities' as any)
        .update({ outcome: 'skipped', outcome_notes: 'Scheduled call cancelled before firing' })
        .eq('call_session_id', sessionId)
        .is('outcome', null);

      // Send CANCEL .ics so the expert's calendar event clears. Best-effort.
      try {
        const { buildIcsInvite, callSessionUid } = await import('@/lib/calendar-invite');
        const { sendCalendarInvite } = await import('@/lib/sendgrid');
        const { data: expert } = await adminSupabase
          .from('profiles')
          .select('email, full_name')
          .eq('id', session.expert_id)
          .single() as { data: { email: string; full_name: string | null } | null };

        if (expert?.email && session.scheduled_for) {
          const startsAt = new Date(session.scheduled_for);
          const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
          const ics = buildIcsInvite({
            uid: callSessionUid(sessionId),
            sequence: 1, // bump from the original REQUEST so clients honor the cancel
            method: 'CANCEL',
            startsAt,
            endsAt,
            summary: `[CANCELLED] IRS PPS Call`,
            description: `This IRS PPS call was cancelled by ${session.expert_name || 'the expert'}. The calendar block has been released.`,
            organizer: { email: process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io', name: 'ModernTax' },
            attendee: { email: expert.email, name: expert.full_name || undefined },
          });

          await sendCalendarInvite({
            to: { email: expert.email, name: expert.full_name || undefined },
            subject: `Cancelled — IRS PPS Call on ${startsAt.toLocaleDateString('en-US', { timeZone: session.scheduled_timezone || 'America/Los_Angeles', dateStyle: 'medium' })}`,
            htmlPreamble: `<p>The IRS PPS call originally scheduled for ${startsAt.toLocaleString('en-US', { timeZone: session.scheduled_timezone || 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })} has been <strong>cancelled</strong>. Your calendar block has been released.</p>`,
            ics,
            method: 'CANCEL',
            cc: ['matt@moderntax.io'],
          });
          console.log(`[irs-call/cancel] Sent CANCEL invite for session ${sessionId} to ${expert.email}`);
        }
      } catch (cancelInviteErr) {
        console.error('[irs-call/cancel] Failed to send CANCEL invite:', cancelInviteErr);
      }

      await logAuditFromRequest(adminSupabase, request, {
        action: 'irs_call_cancelled',
        userId: user.id,
        userEmail: user.email || '',
        resourceType: 'irs_call_session',
        resourceId: sessionId,
        details: { kind: 'scheduled_cancel', scheduled_for: session.scheduled_for },
      });

      return NextResponse.json({ success: true, kind: 'scheduled_cancel' });
    }

    // Stop the AI call via whichever provider owns it (Bland or Retell).
    if (session.bland_call_id) {
      try {
        await stopCallViaProvider(providerForCallId(session.bland_call_id), session.bland_call_id);
      } catch (err) {
        console.error('Failed to stop provider call (may have already ended):', err);
      }
    }

    const now = new Date();
    const initiatedAt = new Date(session.initiated_at);
    const durationSeconds = Math.round((now.getTime() - initiatedAt.getTime()) / 1000);
    const estimatedCost = Math.round((durationSeconds / 60) * (session.cost_per_minute || 0.09) * 100) / 100;

    // Fallback transcript/recording fetch — Bland's completion webhook is unreliable for
    // forcibly stopped calls (sometimes never fires, sometimes lands with null fields).
    // Pull whatever's already available now, then schedule one delayed retry to catch
    // recordings that finish processing 30-60s after the call ends.
    let recordingUrl: string | null = null;
    let concatenatedTranscript: string | null = null;
    let transcriptJson: unknown = null;
    let callSummary: string | null = null;
    if (session.bland_call_id) {
      try {
        const providerStatus = await getCallStatusViaProvider(providerForCallId(session.bland_call_id), session.bland_call_id);
        recordingUrl = providerStatus.recordingUrl || null;
        concatenatedTranscript = providerStatus.transcript || null;
        transcriptJson = null; // provider-unified shape doesn't carry the raw transcript segments
        callSummary = null;    // filled by the post-call analysis webhook
      } catch (err) {
        console.error('Failed to fetch provider call status during cancel (transcript may backfill via webhook):', err);
      }
    }

    await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        status: 'cancelled',
        ended_at: now.toISOString(),
        duration_seconds: durationSeconds,
        estimated_cost: estimatedCost,
        // Only overwrite if we successfully fetched non-null values — preserves anything
        // the webhook may have already written.
        ...(recordingUrl ? { recording_url: recordingUrl } : {}),
        ...(concatenatedTranscript ? { concatenated_transcript: concatenatedTranscript } : {}),
        ...(transcriptJson ? { transcript_json: transcriptJson } : {}),
        ...(callSummary ? { call_summary: callSummary } : {}),
      })
      .eq('id', sessionId);

    // Schedule a delayed retry — Bland's transcription/recording pipeline often finishes
    // 30-90s after the call ends, so we re-poll to backfill anything that wasn't ready
    // at the moment the user clicked End Call. Fire-and-forget; intentionally not awaited.
    if (session.bland_call_id && (!recordingUrl || !concatenatedTranscript)) {
      const providerCallId: string = session.bland_call_id;
      const targetSessionId: string = sessionId;
      setTimeout(() => {
        (async () => {
          try {
            const late = await getCallStatusViaProvider(providerForCallId(providerCallId), providerCallId);
            const update: Record<string, unknown> = {};
            if (late.recordingUrl) update.recording_url = late.recordingUrl;
            if (late.transcript) update.concatenated_transcript = late.transcript;
            if (Object.keys(update).length === 0) return;
            await adminSupabase
              .from('irs_call_sessions' as any)
              .update(update)
              .eq('id', targetSessionId);
          } catch (err) {
            console.error('Delayed transcript backfill failed:', err);
          }
        })();
      }, 75_000);
    }

    // Mark all call entities as skipped
    await adminSupabase
      .from('irs_call_entities' as any)
      .update({ outcome: 'skipped', outcome_notes: 'Call cancelled by expert' })
      .eq('call_session_id', sessionId)
      .is('outcome', null);

    await logAuditFromRequest(adminSupabase, request, {
      action: 'irs_call_cancelled',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'irs_call_session',
      resourceId: sessionId,
      details: { duration_seconds: durationSeconds, estimated_cost: estimatedCost },
    });

    return NextResponse.json({ success: true, durationSeconds, estimatedCost });
  } catch (error) {
    console.error('IRS call cancel error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
