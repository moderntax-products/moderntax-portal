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

        // If Bland says call is completed but our DB doesn't know yet, update
        if (blandStatus.completed && session.status !== 'completed') {
          // Webhook should handle this, but update status as a fallback
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
