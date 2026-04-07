/**
 * IRS Call History
 * GET — Retrieve call history for an expert or specific assignment
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

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
    const assignmentId = url.searchParams.get('assignmentId');
    const expertId = url.searchParams.get('expertId');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const adminSupabase = createAdminClient();

    if (assignmentId) {
      // Fetch calls for a specific assignment
      const { data: callEntities } = await adminSupabase
        .from('irs_call_entities' as any)
        .select('*, irs_call_sessions(*)')
        .eq('assignment_id', assignmentId)
        .order('created_at', { ascending: false }) as { data: any[]; error: any };

      return NextResponse.json({ calls: callEntities || [] });
    }

    // Fetch all calls for expert
    const targetExpertId = profile.role === 'admin' && expertId ? expertId : user.id;

    let query = adminSupabase
      .from('irs_call_sessions' as any)
      .select('*, irs_call_entities(*)')
      .eq('expert_id', targetExpertId)
      .order('initiated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: sessions, error } = await query as { data: any[]; error: any };

    if (error) {
      console.error('Failed to fetch call history:', error);
      return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
    }

    // Also fetch aggregate stats
    const { data: allSessions } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('status, duration_seconds, hold_duration_seconds, estimated_cost')
      .eq('expert_id', targetExpertId) as { data: any[]; error: any };

    const stats = {
      totalCalls: (allSessions || []).length,
      completedCalls: (allSessions || []).filter((s: any) => s.status === 'completed').length,
      totalCost: (allSessions || []).reduce((sum: number, s: any) => sum + (parseFloat(s.estimated_cost) || 0), 0),
      avgDurationMinutes: 0,
      avgHoldMinutes: 0,
    };

    const completedWithDuration = (allSessions || []).filter((s: any) => s.duration_seconds);
    if (completedWithDuration.length > 0) {
      stats.avgDurationMinutes = Math.round(
        completedWithDuration.reduce((sum: number, s: any) => sum + s.duration_seconds, 0) /
        completedWithDuration.length / 60
      );
    }

    const withHold = (allSessions || []).filter((s: any) => s.hold_duration_seconds);
    if (withHold.length > 0) {
      stats.avgHoldMinutes = Math.round(
        withHold.reduce((sum: number, s: any) => sum + s.hold_duration_seconds, 0) /
        withHold.length / 60
      );
    }

    return NextResponse.json({
      sessions: sessions || [],
      stats,
      pagination: { limit, offset, total: stats.totalCalls },
    });
  } catch (error) {
    console.error('IRS call history error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
