/**
 * IRS Call Scheduler Cron
 *
 * Sweeps every 15 minutes M-F and fires any call where
 * scheduled_for <= NOW() AND status='scheduled'.
 *
 * MAY 8 FIX:
 *   - The cron used to run once per day at 14:00 UTC (7 AM PT). A call
 *     scheduled for 12:30 PM PT today (Blue Peaks Roofing) sat in
 *     `scheduled` status all day because the cron wouldn't fire again
 *     until tomorrow's 7 AM run. New schedule: every 15 min M-F so
 *     calls fire close to their scheduled time.
 *   - Replaced direct `lib/bland.initiateCall()` import with the
 *     `lib/voice-provider.initiateCall()` router so calls route to
 *     Retell (production default) instead of dead Bland.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { fireScheduledCall } from '@/lib/fire-call';
import { loadPhonePool, isIrsOpenFor, pickFromNumber } from '@/lib/phone-pool';
import { requireBearer } from '@/lib/auth-util';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();
    const now = new Date();

    // IRS PPS hours check — but we no longer hardcode ET. The IRS honors
    // business hours based on the area-code timezone of the CALLING number,
    // so we're eligible as long as ANY pool number is currently in 7am-7pm
    // local + weekday. This stretches our daily window from 12 hours to
    // 15 hours (4am PT with an ET number → 7pm PT with a PT number).
    const pool = loadPhonePool();
    const anyOpen = pool.length > 0 && pool.some(p => isIrsOpenFor(p.tz, now));
    if (!anyOpen) {
      // No pool eligibility — fall back to ET weekday check for Bland mode.
      const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etDay = etTime.getDay();
      const etHour = etTime.getHours();
      if (etDay === 0 || etDay === 6) {
        return NextResponse.json({ success: true, message: 'IRS PPS closed on weekends', skipped: true });
      }
      if (etHour < 7 || etHour >= 19) {
        return NextResponse.json({
          success: true,
          message: `IRS PPS closed in all configured timezones (no pool entry in 7am-7pm local)`,
          skipped: true,
          pool_size: pool.length,
        });
      }
    }
    const activePoolEntry = pool.length > 0 ? pickFromNumber(pool, now) : null;
    if (activePoolEntry) {
      console.log(`[irs-call-scheduler] active pool entry: ${activePoolEntry.label || activePoolEntry.phone} (${activePoolEntry.tz})`);
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
        // Delegate to lib/fire-call — single source of truth, also used by
        // the inline-fire path in /api/expert/irs-call/initiate when an
        // expert schedules a call within 5 min of "now".
        const r = await fireScheduledCall(supabase as any, session.id);
        processed++;
        results.push({ sessionId: session.id, status: 'fired' });
        console.log(`Scheduled call ${session.id} fired via ${r.provider}: call_id=${r.call_id}`);
      } catch (err) {
        console.error(`Failed to fire scheduled call ${session.id}:`, err);
        failed++;
        // fire-call.ts already rolls the session to status='failed' on
        // unrecoverable errors; record the error in the response payload.
        await (supabase.from('irs_call_sessions' as any) as any)
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
