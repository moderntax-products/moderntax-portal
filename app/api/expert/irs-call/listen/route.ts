/**
 * IRS PPS Call Live Listen
 * GET — Get WebSocket URL to listen to an active IRS call in real-time.
 *
 * The expert hears the IRS phone tree, hold music, and agent greeting
 * directly in their browser. When the agent answers, the expert takes over.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getLiveListenUrl } from '@/lib/bland';

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

    const adminSupabase = createAdminClient();

    // Verify expert owns this call session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, bland_call_id, status')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (!session || session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    if (!session.bland_call_id) {
      return NextResponse.json({ error: 'Call not yet connected' }, { status: 400 });
    }

    const activeStatuses = ['initiating', 'ringing', 'navigating_ivr', 'on_hold', 'speaking_to_agent'];
    if (!activeStatuses.includes(session.status)) {
      return NextResponse.json({ error: 'Call is not active' }, { status: 400 });
    }

    const wsUrl = await getLiveListenUrl(session.bland_call_id);

    return NextResponse.json({ wsUrl });
  } catch (error) {
    console.error('Live listen error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get live listen URL' },
      { status: 500 }
    );
  }
}
