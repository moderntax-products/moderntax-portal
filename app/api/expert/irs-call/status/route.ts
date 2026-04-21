/**
 * IRS Call Status
 * GET — Poll the current status of an IRS PPS call session
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getCallStatus as getBlandStatus } from '@/lib/bland';

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

    // If call is active, optionally poll Bland for live status
    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    let blandStatus = null;

    if (activeStatuses.includes(session.status) && session.bland_call_id) {
      try {
        blandStatus = await getBlandStatus(session.bland_call_id);

        // Completion fallback — webhook SHOULD handle this, but it's unreliable
        // (see the 2026-04-21 incidents where the DB stayed on `ringing` for 29
        // min after Bland marked the call `completed`). Force-reconcile here.
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

        // Intermediate-status reconciliation — same bug class as above but for
        // transitions within the active lifecycle. The DB gets stuck on `ringing`
        // for the entire call because the status-transition webhook from Bland
        // isn't firing (or is being rejected). We infer the real state from the
        // transcript and update the DB so the UI shows reality.
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

    return NextResponse.json({
      session: {
        ...session,
        elapsed_seconds: activeStatuses.includes(session.status) ? elapsedSeconds : session.duration_seconds,
        running_cost: activeStatuses.includes(session.status) ? runningCost : session.estimated_cost,
      },
      blandStatus: blandStatus ? {
        completed: blandStatus.completed,
        answeredBy: blandStatus.answered_by,
      } : null,
    });
  } catch (error) {
    console.error('IRS call status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
