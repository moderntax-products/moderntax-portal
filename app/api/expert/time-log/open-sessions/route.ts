/**
 * GET /api/expert/time-log/open-sessions
 *
 * Returns the calling expert's currently-open time-log sessions
 * (end_at IS NULL). Used by the dashboard widget to show "on the
 * clock" badge + minutes-running counter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (!profile || profile.role !== 'expert') {
    return NextResponse.json({ error: 'Expert role required' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.from('expert_time_logs')
    .select('id, kind, start_at, last_activity_at, attributed_entity_ids, notes')
    .eq('expert_id', user.id)
    .is('end_at', null)
    .order('start_at', { ascending: true }) as { data: any[] | null; error: any };
  if (error) return NextResponse.json({ error: 'Query failed', detail: error.message }, { status: 500 });

  return NextResponse.json({ sessions: data || [] });
}
