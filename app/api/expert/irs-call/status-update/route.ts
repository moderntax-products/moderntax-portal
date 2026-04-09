/**
 * IRS Call Status Update (Mid-Call)
 * POST — Bland AI tool endpoint for real-time call status reporting
 *
 * The AI calls this at each stage of the IRS PPS call:
 * - wait_estimate: heard the estimated wait time
 * - holding: decided to hold (short wait)
 * - callback_accepted: accepted IRS callback (long wait)
 * - agent_answered: live IRS agent picked up
 *
 * Updates irs_call_sessions for real-time SLA tracking.
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
    const { session_id, event, estimated_wait_minutes, callback_phone, notes } = body;

    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 });
    }

    const supabase = createAdminClient();
    const now = new Date().toISOString();

    const update: Record<string, unknown> = {
      updated_at: now,
    };

    switch (event) {
      case 'wait_estimate':
        // AI heard the IRS estimated wait time
        update.status = 'on_hold';
        update.hold_start_at = now;
        if (estimated_wait_minutes) {
          // Store in coaching_notes for visibility
          update.coaching_notes = `IRS estimated wait: ${estimated_wait_minutes} min`;
        }
        break;

      case 'holding':
        // AI decided to hold (short wait)
        update.status = 'on_hold';
        update.callback_status = 'holding';
        if (estimated_wait_minutes) {
          update.coaching_notes = `Holding — IRS estimated ${estimated_wait_minutes} min wait`;
        }
        break;

      case 'callback_accepted':
        // AI accepted IRS callback option
        update.status = 'completed';
        update.callback_status = 'waiting';
        update.callback_mode = 'irs_callback';
        if (callback_phone) {
          update.callback_phone = callback_phone;
        }
        if (estimated_wait_minutes) {
          update.coaching_notes = `IRS callback accepted — estimated ${estimated_wait_minutes} min until callback`;
          // Store expected callback time
          const expectedAt = new Date(Date.now() + estimated_wait_minutes * 60 * 1000);
          update.callback_initiated_at = expectedAt.toISOString();
        }
        break;

      case 'agent_answered':
        // Live IRS agent picked up
        update.status = 'speaking_to_agent';
        update.agent_answered_at = now;
        update.callback_status = 'transferring';
        break;

      default:
        // Unknown event — still log it
        if (notes) {
          update.coaching_notes = `${event}: ${notes}`;
        }
        break;
    }

    const { error } = await supabase
      .from('irs_call_sessions' as any)
      .update(update)
      .eq('id', session_id);

    if (error) {
      console.error('Status update failed:', error);
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }

    // Log audit event
    try {
      await supabase.from('audit_log' as any).insert({
        user_email: '',
        action: `irs_call_${event}`,
        entity_type: 'irs_call_session',
        entity_id: session_id,
        details: { event, estimated_wait_minutes, callback_phone, notes },
      } as any);
    } catch (auditErr) {
      console.error('Audit log failed:', auditErr);
    }

    return NextResponse.json({
      success: true,
      event,
      message: `Status updated: ${event}`,
    });
  } catch (error) {
    console.error('Status update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
