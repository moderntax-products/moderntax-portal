/**
 * IRS Call Transfer Notification
 * POST — Bland AI mid-call tool endpoint
 *
 * Fired when the AI detects a live IRS agent answered and initiates
 * the transfer to the expert's personal phone.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  try {
    // Validate webhook secret
    const webhookSecret = request.headers.get('x-bland-secret');
    const expectedSecret = process.env.BLAND_WEBHOOK_SECRET;

    if (expectedSecret && webhookSecret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { session_id, reason } = body;

    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Update the call session to reflect transfer in progress
    const { data: session, error } = await adminSupabase
      .from('irs_call_sessions' as any)
      .update({
        status: 'speaking_to_agent',
        callback_status: 'transferring',
        callback_initiated_at: new Date().toISOString(),
        agent_answered_at: new Date().toISOString(),
      })
      .eq('id', session_id)
      .select('id, expert_id, callback_phone, callback_mode')
      .single() as { data: any; error: any };

    if (error || !session) {
      console.error('Transfer notify: session not found or update failed', error);
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Log audit event
    try {
      await adminSupabase.from('audit_log' as any).insert({
        user_email: '',
        action: 'irs_call_transfer_initiated',
        entity_type: 'irs_call_session',
        entity_id: session.id,
        details: {
          callback_phone: session.callback_phone,
          callback_mode: session.callback_mode,
          reason: reason || 'IRS agent answered',
        },
      } as any);
    } catch (auditErr) {
      console.error('Audit log failed:', auditErr);
    }

    // Return success — Bland AI will proceed with the native transfer
    return NextResponse.json({
      success: true,
      message: `Transferring call to ${session.callback_phone}`,
    });
  } catch (error) {
    console.error('Transfer notify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
