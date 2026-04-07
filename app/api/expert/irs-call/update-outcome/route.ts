/**
 * IRS Call Update Outcome
 * PATCH — Expert manually updates per-entity outcomes and coaching tags
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export async function PATCH(request: NextRequest) {
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
    const { callEntityId, sessionId, outcome, outcomeNotes, coachingTags, coachingNotes } = body;

    const adminSupabase = createAdminClient();

    // Update per-entity outcome
    if (callEntityId && outcome) {
      const { data: callEntity } = await adminSupabase
        .from('irs_call_entities' as any)
        .select('*, irs_call_sessions(expert_id)')
        .eq('id', callEntityId)
        .single() as { data: any; error: any };

      if (!callEntity) {
        return NextResponse.json({ error: 'Call entity not found' }, { status: 404 });
      }

      if (profile.role !== 'admin' && callEntity.irs_call_sessions?.expert_id !== user.id) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }

      const updateData: Record<string, unknown> = { outcome };
      if (outcomeNotes !== undefined) updateData.outcome_notes = outcomeNotes;

      await adminSupabase
        .from('irs_call_entities' as any)
        .update(updateData)
        .eq('id', callEntityId);

      return NextResponse.json({ success: true, updated: 'call_entity' });
    }

    // Update session coaching metadata
    if (sessionId) {
      const { data: session } = await adminSupabase
        .from('irs_call_sessions' as any)
        .select('id, expert_id')
        .eq('id', sessionId)
        .single() as { data: any; error: any };

      if (!session) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }

      if (profile.role !== 'admin' && session.expert_id !== user.id) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }

      const updateData: Record<string, unknown> = {};
      if (coachingTags) updateData.coaching_tags = coachingTags;
      if (coachingNotes !== undefined) updateData.coaching_notes = coachingNotes;

      if (Object.keys(updateData).length > 0) {
        await adminSupabase
          .from('irs_call_sessions' as any)
          .update(updateData)
          .eq('id', sessionId);
      }

      return NextResponse.json({ success: true, updated: 'session' });
    }

    return NextResponse.json({ error: 'callEntityId or sessionId required' }, { status: 400 });
  } catch (error) {
    console.error('IRS call update outcome error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
