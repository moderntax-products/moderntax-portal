/**
 * IRS Call Cancel
 * POST — Cancel an active IRS PPS call
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { stopCall } from '@/lib/bland';

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
      .select('id, expert_id, bland_call_id, status, initiated_at, cost_per_minute')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (profile.role !== 'admin' && session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    if (!activeStatuses.includes(session.status)) {
      return NextResponse.json({ error: 'Call is not active' }, { status: 400 });
    }

    // Stop the Bland AI call
    if (session.bland_call_id) {
      try {
        await stopCall(session.bland_call_id);
      } catch (err) {
        console.error('Failed to stop Bland call (may have already ended):', err);
      }
    }

    const now = new Date();
    const initiatedAt = new Date(session.initiated_at);
    const durationSeconds = Math.round((now.getTime() - initiatedAt.getTime()) / 1000);
    const estimatedCost = Math.round((durationSeconds / 60) * (session.cost_per_minute || 0.09) * 100) / 100;

    await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        status: 'cancelled',
        ended_at: now.toISOString(),
        duration_seconds: durationSeconds,
        estimated_cost: estimatedCost,
      })
      .eq('id', sessionId);

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
