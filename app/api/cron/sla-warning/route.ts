/**
 * SLA Warning Cron Job
 *
 * Sends warning emails to experts when their assignment is within
 * 4 business hours of the SLA deadline. The deadline is computed live
 * via lib/expert-sla — Mon–Fri 7am–7pm in the expert's local timezone,
 * starting from expert_clock_started_at (the verified-signed-8821 ts).
 *
 * Replaces the old logic that read a static sla_deadline column with
 * naive wall-clock math. Assignments where the clock hasn't started
 * (expert_clock_started_at IS NULL) are skipped entirely — they're not
 * yet on the hook.
 *
 * GET /api/cron/sla-warning  (Authorization: Bearer CRON_SECRET)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendSlaWarningNotification } from '@/lib/sendgrid';
import { businessHoursRemaining, slaDeadlineMs, SLA_DEFAULTS } from '@/lib/expert-sla';
import { requireBearer } from '@/lib/auth-util';

export const maxDuration = 60;

const WARN_WITHIN_BUSINESS_HOURS = 4;

export async function GET(request: NextRequest) {
  try {
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();
    const now = Date.now();

    // Pull active assignments where the clock IS running (signed 8821 verified).
    // We over-fetch and filter in JS because the deadline is a function of the
    // expert's tz — can't be expressed as a SQL predicate cleanly.
    const { data: liveAssignments, error: assignmentsError } = await supabase
      .from('expert_assignments')
      .select(`
        id,
        expert_clock_started_at,
        sla_business_hours,
        expert_id,
        entity_id,
        expert_profile:profiles!expert_assignments_expert_id_fkey(email, full_name, iana_timezone),
        request_entities(entity_name)
      `)
      .in('status', ['assigned', 'in_progress'])
      .not('expert_clock_started_at', 'is', null) as { data: any[] | null; error: any };

    if (assignmentsError) {
      console.error('[sla-warning] Failed to fetch assignments:', assignmentsError);
      return NextResponse.json({ error: 'Failed to fetch assignments' }, { status: 500 });
    }

    if (!liveAssignments || liveAssignments.length === 0) {
      return NextResponse.json({
        success: true, warningsSent: 0,
        message: 'No assignments with running SLA clock',
        processedAt: new Date(now).toISOString(),
      });
    }

    // Filter to assignments approaching deadline (within 4 business hours, but not yet past)
    const urgent = liveAssignments.filter(a => {
      const tz = a.expert_profile?.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;
      const startedMs = new Date(a.expert_clock_started_at).getTime();
      const slaHours = a.sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS;
      const remaining = businessHoursRemaining(startedMs, slaHours, tz, now);
      if (remaining === null) return false;
      return remaining > 0 && remaining <= WARN_WITHIN_BUSINESS_HOURS;
    });

    let warningsSent = 0;
    const errors: { assignmentId: string; error: string }[] = [];

    for (const assignment of urgent) {
      try {
        const expertEmail = assignment.expert_profile?.email;
        const tz = assignment.expert_profile?.iana_timezone || SLA_DEFAULTS.EXPERT_TZ;
        const entityName = assignment.request_entities?.entity_name || 'Unknown Entity';
        const startedMs = new Date(assignment.expert_clock_started_at).getTime();
        const slaHours = assignment.sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS;
        const hoursRemaining = businessHoursRemaining(startedMs, slaHours, tz, now) || 0;

        if (expertEmail) {
          await sendSlaWarningNotification(
            expertEmail,
            entityName,
            Math.round(hoursRemaining * 10) / 10
          );
          warningsSent++;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[sla-warning] Failed for assignment ${assignment.id}:`, errorMessage);
        errors.push({ assignmentId: assignment.id, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      warningsSent,
      totalUrgent: urgent.length,
      totalLiveClock: liveAssignments.length,
      processedAt: new Date(now).toISOString(),
      errors: errors.length > 0 ? errors : undefined,
      // Diagnostic: show a sample deadline so on-call can sanity-check
      sample: urgent[0] ? {
        assignmentId: urgent[0].id,
        deadlineUtc: new Date(slaDeadlineMs(
          new Date(urgent[0].expert_clock_started_at).getTime(),
          urgent[0].sla_business_hours ?? SLA_DEFAULTS.DEFAULT_SLA_BUSINESS_HOURS,
          urgent[0].expert_profile?.iana_timezone || SLA_DEFAULTS.EXPERT_TZ,
        ) || 0).toISOString(),
      } : undefined,
    });
  } catch (error) {
    console.error('[sla-warning] cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Cron job failed', details: errorMessage }, { status: 500 });
  }
}
