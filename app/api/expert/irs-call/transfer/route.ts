/**
 * IRS Call Manual Transfer
 * POST — Expert triggers call transfer to their phone from the dashboard.
 *
 * When the expert hears the IRS agent answer via live listen,
 * they click "Transfer to My Phone" which hits this endpoint.
 * We update the session status and tell Bland AI to transfer the call.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { transferCall } from '@/lib/bland';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { sessionId } = await request.json();
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });

    const adminSupabase = createAdminClient();

    // Verify expert owns this call session
    const { data: session } = await adminSupabase
      .from('irs_call_sessions' as any)
      .select('id, expert_id, bland_call_id, status, callback_phone')
      .eq('id', sessionId)
      .single() as { data: any; error: any };

    if (!session || session.expert_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    if (!session.bland_call_id) {
      return NextResponse.json({ error: 'Call not yet connected' }, { status: 400 });
    }

    if (!session.callback_phone) {
      return NextResponse.json({ error: 'No callback phone on file. Update your profile.' }, { status: 400 });
    }

    const activeStatuses = ['navigating_ivr', 'on_hold', 'speaking_to_agent'];
    if (!activeStatuses.includes(session.status)) {
      return NextResponse.json({ error: 'Call is not in a transferable state' }, { status: 400 });
    }

    // Trigger transfer via Bland AI API
    await transferCall(session.bland_call_id, session.callback_phone);

    // Update session status
    await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        status: 'speaking_to_agent',
        callback_status: 'transferring',
        callback_initiated_at: new Date().toISOString(),
        agent_answered_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    return NextResponse.json({
      success: true,
      message: `Transferring call to ${session.callback_phone}`,
    });
  } catch (error) {
    console.error('Manual transfer error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transfer failed' },
      { status: 500 }
    );
  }
}
