/**
 * IRS Call Status
 * GET — Poll the current status of an IRS PPS call session
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getCallStatus as getProviderStatus, providerForCallId } from '@/lib/voice-provider';

export async function GET(request: NextRequest) {
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

    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Fetch session with entities
    const { data: session, error } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('*, irs_call_entities(*)')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (error || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Verify access
    if (profile.role !== 'admin' && session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized for this session' }, { status: 403 });
    }

    // If call is active, poll the active provider for live status. The
    // provider router translates Bland/Retell responses into a unified shape
    // so the rest of this function stays provider-agnostic.
    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    let blandStatus: { completed: boolean; concatenated_transcript?: string; call_length?: number; recording_url?: string } | null = null;

    if (activeStatuses.includes(session.status) && session.bland_call_id) {
      try {
        const providerStatus = await getProviderStatus(providerForCallId(session.bland_call_id), session.bland_call_id);
        // Map unified shape back to the local `blandStatus` variable name so
        // the existing transcript-inference logic below still works unchanged.
        blandStatus = {
          completed: providerStatus.completed,
          concatenated_transcript: providerStatus.transcript,
          call_length: providerStatus.durationMs ? providerStatus.durationMs / 60_000 : undefined,
          recording_url: providerStatus.recordingUrl,
        };

        // Completion fallback — webhook SHOULD handle this, but it's unreliable.
        if (blandStatus.completed && session.status !== 'completed') {
          const elapsedMinutes = blandStatus.call_length || 0;
          await adminSupabase
            .from('irs_call_sessions' as any)
            .update({
              status: 'completed',
              ended_at: new Date().toISOString(),
              duration_seconds: Math.round(elapsedMinutes * 60),
              recording_url: blandStatus.recording_url || null,
              concatenated_transcript: blandStatus.concatenated_transcript || null,
              estimated_cost: Math.round(elapsedMinutes * (session.cost_per_minute || 0.09) * 100) / 100,
            })
            .eq('id', session.id);
          session.status = 'completed';
        }

        // Intermediate-status reconciliation — infer live state from transcript
        // when webhook transitions don't fire.
        if (!blandStatus.completed && blandStatus.concatenated_transcript) {
          const t = String(blandStatus.concatenated_transcript).toLowerCase();
          let inferred: string | null = null;
          // Precedence: agent-on-line → hold → IVR → ringing.
          // "how can i help you" and similar live-agent greetings beat everything.
          if (/thank you for calling|how (can|may) i help|this is (ms?|mrs|miss|mr)\b.+?\s+(?:my )?(?:id|badge)/.test(t)) {
            inferred = 'speaking_to_agent';
          } else if (/please continue to hold|our representatives are still|we estimate your wait time|please hold while your call is transferred/.test(t)) {
            inferred = 'on_hold';
          } else if (/welcome to the internal revenue service|please listen carefully|practitioner priority service line/.test(t)) {
            // We've passed IVR and entered hold queue, but haven't hit a hold-loop phrase yet
            inferred = session.status === 'ringing' || session.status === 'initiating' ? 'navigating_ivr' : session.status;
          }

          if (inferred && inferred !== session.status) {
            const updateFields: Record<string, unknown> = { status: inferred };
            // Stamp hold_start_at the first time we see the hold loop
            if (inferred === 'on_hold' && !session.hold_start_at) {
              updateFields.hold_start_at = new Date().toISOString();
            }
            // Stamp agent_answered_at the first time we detect a live agent
            if (inferred === 'speaking_to_agent' && !session.agent_answered_at) {
              updateFields.agent_answered_at = new Date().toISOString();
            }
            await adminSupabase
              .from('irs_call_sessions' as any)
              .update(updateFields)
              .eq('id', session.id);
            session.status = inferred;
            if (inferred === 'on_hold' && !session.hold_start_at) session.hold_start_at = updateFields.hold_start_at;
            if (inferred === 'speaking_to_agent' && !session.agent_answered_at) session.agent_answered_at = updateFields.agent_answered_at;
          }
        }
      } catch (blandError) {
        // Non-fatal — return DB status
        console.error('Bland status poll failed:', blandError);
      }
    }

    // Compute running metrics
    const initiatedAt = new Date(session.initiated_at);
    const elapsedSeconds = Math.round((Date.now() - initiatedAt.getTime()) / 1000);
    const runningCost = Math.round((elapsedSeconds / 60) * (session.cost_per_minute || 0.09) * 100) / 100;

    // Live transcript — return whichever is freshest. Bland's poll wins if it
    // returned something; otherwise fall back to whatever we last persisted.
    // The UI uses this for the "Live Transcript" panel (replacement for the
    // plan-gated Live Audio feature).
    const liveTranscript: string | null =
      blandStatus?.concatenated_transcript || session.concatenated_transcript || null;

    return NextResponse.json({
      session: {
        ...session,
        elapsed_seconds: activeStatuses.includes(session.status) ? elapsedSeconds : session.duration_seconds,
        running_cost: activeStatuses.includes(session.status) ? runningCost : session.estimated_cost,
        concatenated_transcript: liveTranscript,
      },
      blandStatus: blandStatus ? {
        completed: blandStatus.completed,
      } : null,
    });
  } catch (error) {
    console.error('IRS call status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
