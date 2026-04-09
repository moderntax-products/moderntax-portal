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
import { sendExpertCallbackNotification } from '@/lib/sendgrid';

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

      case 'callback_accepted': {
        // AI accepted IRS callback option
        update.status = 'completed';
        update.callback_status = 'waiting';
        update.callback_mode = 'irs_callback';
        if (callback_phone) {
          update.callback_phone = callback_phone;
        }
        const waitMin = estimated_wait_minutes || 30;
        update.coaching_notes = `IRS callback accepted — estimated ${waitMin} min until callback`;
        const expectedAt = new Date(Date.now() + waitMin * 60 * 1000);
        update.callback_initiated_at = expectedAt.toISOString();

        // Send expert email notification about the callback
        try {
          // Look up session to get expert info
          const { data: sess } = await supabase
            .from('irs_call_sessions' as any)
            .select('expert_id, expert_name, callback_phone')
            .eq('id', session_id)
            .single();

          if (sess) {
            // Get expert email
            const { data: profile } = await supabase
              .from('profiles' as any)
              .select('email')
              .eq('id', (sess as any).expert_id)
              .single();

            // Get entities for this session
            const { data: callEntities } = await supabase
              .from('irs_call_entities' as any)
              .select('entity_id')
              .eq('session_id', session_id);

            let entities: { taxpayerName: string; formType: string; years: string[] }[] = [];
            if (callEntities && (callEntities as any[]).length > 0) {
              const entityIds = (callEntities as any[]).map((ce: any) => ce.entity_id);
              const { data: entityData } = await supabase
                .from('entities' as any)
                .select('name, form_type, tax_years')
                .in('id', entityIds);

              if (entityData) {
                entities = (entityData as any[]).map((e: any) => ({
                  taxpayerName: e.name || 'Unknown',
                  formType: e.form_type || 'Tax Return',
                  years: e.tax_years || [],
                }));
              }
            }

            const expertEmail = (profile as any)?.email;
            const expertPhone = callback_phone || (sess as any).callback_phone || '';
            if (expertEmail) {
              await sendExpertCallbackNotification(
                expertEmail,
                (sess as any).expert_name || 'Expert',
                expertPhone,
                waitMin,
                entities
              );
            }
          }
        } catch (emailErr) {
          console.error('Failed to send callback notification email:', emailErr);
        }
        break;
      }

      case 'agent_answered':
        // Live IRS agent picked up
        update.status = 'speaking_to_agent';
        update.agent_answered_at = now;
        update.callback_status = 'transferring';
        break;

      case 'hold_timeout':
        // AI hung up after max hold time (5 min) — no callback was available
        update.status = 'failed';
        update.callback_status = 'no_answer';
        update.coaching_notes = notes || 'Hold timeout — no callback option offered, hung up after 5 min';
        break;

      case 'expert_pre_connected':
        // Expert was pre-connected to the call
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
