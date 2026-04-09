/**
 * IRS Call Scheduler Cron
 * Runs every 5 minutes during IRS PPS hours (7am-7pm ET, Mon-Fri)
 *
 * Finds scheduled call sessions where scheduled_for <= NOW()
 * and fires them via Bland AI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { initiateCall } from '@/lib/bland';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const now = new Date();

    // Check if we're in IRS PPS operating hours (7am-7pm ET, Mon-Fri)
    // Convert to ET for the check
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = etTime.getHours();
    const day = etTime.getDay();

    if (day === 0 || day === 6) {
      return NextResponse.json({
        success: true,
        message: 'IRS PPS closed on weekends',
        skipped: true,
      });
    }

    if (hour < 7 || hour >= 19) {
      return NextResponse.json({
        success: true,
        message: `IRS PPS closed (current ET hour: ${hour})`,
        skipped: true,
      });
    }

    // ---------------------------------------------------------------
    // Phase 1: Convert expert availability commitments into scheduled call sessions
    // ---------------------------------------------------------------
    await scheduleFromAvailability(supabase, now);

    // ---------------------------------------------------------------
    // Phase 2: Fire all scheduled calls that are due
    // ---------------------------------------------------------------
    const { data: dueSessions, error: fetchError } = await supabase
      .from('irs_call_sessions' as any)
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_for', now.toISOString()) as { data: any[] | null; error: any };

    if (fetchError) {
      console.error('Failed to fetch scheduled calls:', fetchError);
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 });
    }

    if (!dueSessions || dueSessions.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No scheduled calls due',
        processed: 0,
      });
    }

    let processed = 0;
    let failed = 0;
    const results: { sessionId: string; status: string; error?: string }[] = [];

    for (const session of dueSessions) {
      try {
        // Fetch the call entities for this session
        const { data: callEntities } = await supabase
          .from('irs_call_entities' as any)
          .select('*, request_entities(id, entity_name, tid, tid_kind, form_type, years)')
          .eq('call_session_id', session.id) as { data: any[]; error: any };

        if (!callEntities || callEntities.length === 0) {
          console.error(`Scheduled call ${session.id}: no entities found`);
          failed++;
          results.push({ sessionId: session.id, status: 'no_entities' });
          continue;
        }

        // Fetch expert profile for full details
        const { data: expertProfile } = await supabase
          .from('profiles')
          .select('id, full_name, caf_number, phone_number, fax_number, address')
          .eq('id', session.expert_id)
          .single();

        if (!expertProfile) {
          console.error(`Scheduled call ${session.id}: expert profile not found`);
          failed++;
          results.push({ sessionId: session.id, status: 'expert_not_found' });
          continue;
        }

        // Update status to initiating
        await supabase
          .from('irs_call_sessions' as any)
          .update({ status: 'initiating', initiated_at: now.toISOString() })
          .eq('id', session.id);

        // Determine call mode and callback phone
        const callMode = session.callback_mode === 'irs_callback' ? 'irs_callback'
          : session.callback_mode === 'transfer' ? 'hold_and_transfer'
          : (session.callback_phone ? 'hold_and_transfer' : 'ai_full');
        const callbackPhone = session.callback_phone || expertProfile.phone_number || undefined;

        // Fire the Bland AI call
        const blandResponse = await initiateCall({
          expertName: session.expert_name || expertProfile.full_name,
          cafNumber: session.caf_number || expertProfile.caf_number,
          expertFax: session.expert_fax || expertProfile.fax_number || undefined,
          expertPhone: expertProfile.phone_number || undefined,
          expertAddress: expertProfile.address || undefined,
          callMode,
          callbackPhone,
          entities: callEntities.map((ce: any) => ({
            entityId: ce.entity_id,
            taxpayerName: ce.taxpayer_name,
            taxpayerTid: ce.taxpayer_tid,
            tidKind: (ce.request_entities?.tid_kind || 'EIN') as 'SSN' | 'EIN',
            formType: ce.form_type,
            years: ce.tax_years,
          })),
          metadata: {
            sessionId: session.id,
            expertId: session.expert_id,
            assignmentIds: callEntities.map((ce: any) => ce.assignment_id),
          },
        });

        // Update session with Bland call ID
        await supabase
          .from('irs_call_sessions' as any)
          .update({
            bland_call_id: blandResponse.call_id,
            status: 'ringing',
          })
          .eq('id', session.id);

        // Transition assignments to in_progress
        for (const ce of callEntities) {
          await supabase
            .from('expert_assignments')
            .update({ status: 'in_progress' })
            .eq('id', ce.assignment_id)
            .eq('status', 'assigned');
        }

        processed++;
        results.push({ sessionId: session.id, status: 'fired', });

        console.log(`Scheduled call ${session.id} fired: Bland call ${blandResponse.call_id}`);
      } catch (err) {
        console.error(`Failed to fire scheduled call ${session.id}:`, err);
        failed++;

        // Mark as failed
        await supabase
          .from('irs_call_sessions' as any)
          .update({
            status: 'failed',
            ended_at: now.toISOString(),
            error_message: err instanceof Error ? err.message : 'Scheduled call failed to fire',
          })
          .eq('id', session.id);

        results.push({
          sessionId: session.id,
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      total_due: dueSessions.length,
      processed,
      failed,
      results,
      processedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('IRS call scheduler cron error:', error);
    return NextResponse.json(
      { error: 'Cron failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Convert expert availability commitments → scheduled call sessions
// ---------------------------------------------------------------------------
async function scheduleFromAvailability(supabase: any, now: Date) {
  try {
    // Find committed availability slots for today (or past due)
    const todayStr = now.toISOString().split('T')[0];

    const { data: slots } = await supabase
      .from('expert_availability')
      .select('*')
      .eq('status', 'committed')
      .lte('available_date', todayStr) as { data: any[] | null };

    if (!slots || slots.length === 0) return;

    for (const slot of slots) {
      try {
        // Get expert profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, full_name, caf_number, phone_number, fax_number')
          .eq('id', slot.expert_id)
          .single();

        if (!profile || !profile.caf_number) {
          console.error(`Availability ${slot.id}: expert ${slot.expert_id} missing profile/CAF`);
          continue;
        }

        // Get pending assignments for this expert
        let assignmentQuery = supabase
          .from('expert_assignments')
          .select('id, entity_id, request_entities(id, entity_name, tid, tid_kind, form_type, years)')
          .eq('expert_id', slot.expert_id)
          .in('status', ['assigned', 'in_progress']);

        // If specific assignment IDs were listed, filter to those
        if (slot.assignment_ids && slot.assignment_ids.length > 0) {
          assignmentQuery = assignmentQuery.in('id', slot.assignment_ids);
        }

        const { data: assignments } = await assignmentQuery as { data: any[] | null };

        if (!assignments || assignments.length === 0) {
          // No pending work — mark slot as skipped
          await supabase
            .from('expert_availability')
            .update({ status: 'skipped', updated_at: now.toISOString() })
            .eq('id', slot.id);
          continue;
        }

        // Build scheduled_for timestamp from date + start_time + timezone
        const scheduledFor = new Date(`${slot.available_date}T${slot.start_time}:00`);
        // If the slot time has already passed, schedule for right now
        const fireAt = scheduledFor < now ? now : scheduledFor;

        const callbackPhone = slot.callback_phone || profile.phone_number;
        const callbackMode = slot.call_mode === 'irs_callback' ? 'irs_callback' : 'transfer';

        // Batch assignments into groups of up to 5 (IRS call limit)
        const batches: any[][] = [];
        for (let i = 0; i < assignments.length; i += 5) {
          batches.push(assignments.slice(i, i + 5));
        }

        const sessionIds: string[] = [];

        for (const batch of batches) {
          // Create call session
          const { data: session, error: sessionErr } = await supabase
            .from('irs_call_sessions' as any)
            .insert({
              expert_id: slot.expert_id,
              status: 'scheduled',
              scheduled_for: fireAt.toISOString(),
              scheduled_timezone: slot.timezone || 'America/New_York',
              caf_number: profile.caf_number,
              expert_name: profile.full_name,
              expert_fax: profile.fax_number || null,
              callback_phone: callbackPhone,
              callback_mode: callbackMode,
              callback_status: 'waiting',
              cost_per_minute: 0.09,
            })
            .select('id')
            .single() as { data: any; error: any };

          if (sessionErr || !session) {
            console.error(`Failed to create session for availability ${slot.id}:`, sessionErr);
            continue;
          }

          sessionIds.push(session.id);

          // Create call entities
          for (const asn of batch) {
            const entity = asn.request_entities;
            await supabase.from('irs_call_entities' as any).insert({
              call_session_id: session.id,
              assignment_id: asn.id,
              entity_id: asn.entity_id,
              taxpayer_name: entity.entity_name,
              taxpayer_tid: entity.tid,
              form_type: entity.form_type,
              tax_years: entity.years,
            });
          }

          console.log(`Created scheduled call session ${session.id} from availability ${slot.id} (${batch.length} entities)`);
        }

        // Mark availability as scheduled
        await supabase
          .from('expert_availability')
          .update({
            status: 'scheduled',
            call_session_id: sessionIds[0] || null,
            updated_at: now.toISOString(),
          })
          .eq('id', slot.id);

      } catch (slotErr) {
        console.error(`Error processing availability slot ${slot.id}:`, slotErr);
      }
    }
  } catch (err) {
    console.error('scheduleFromAvailability error:', err);
  }
}
