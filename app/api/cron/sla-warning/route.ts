/**
 * SLA Warning Cron Job
 * Checks for expert assignments approaching their SLA deadline (< 4 hours remaining)
 * and sends warning emails to experts.
 * GET /api/cron/sla-warning
 *
 * Expected to be called by Vercel Cron with CRON_SECRET in headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendSlaWarningNotification } from '@/lib/sendgrid';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Find active assignments where SLA deadline is within the next 4 hours
    const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { data: urgentAssignments, error: assignmentsError } = await supabase
      .from('expert_assignments')
      .select(`
        id, sla_deadline, expert_id, entity_id,
        expert_profile:profiles!expert_assignments_expert_id_fkey(email, full_name),
        request_entities(entity_name)
      `)
      .in('status', ['assigned', 'in_progress'])
      .lte('sla_deadline', fourHoursFromNow)
      .gte('sla_deadline', now) as { data: any[] | null; error: any };

    if (assignmentsError) {
      console.error('Failed to fetch urgent assignments:', assignmentsError);
      return NextResponse.json(
        { error: 'Failed to fetch assignments' },
        { status: 500 }
      );
    }

    if (!urgentAssignments || urgentAssignments.length === 0) {
      return NextResponse.json({
        success: true,
        warningsSent: 0,
        message: 'No assignments approaching SLA deadline',
        processedAt: now,
      });
    }

    let warningsSent = 0;
    const errors: { assignmentId: string; error: string }[] = [];

    for (const assignment of urgentAssignments) {
      try {
        const expertEmail = assignment.expert_profile?.email;
        const entityName = assignment.request_entities?.entity_name || 'Unknown Entity';
        const deadline = new Date(assignment.sla_deadline);
        const hoursRemaining = Math.max(0, (deadline.getTime() - Date.now()) / (1000 * 60 * 60));

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
        console.error(`Error sending SLA warning for assignment ${assignment.id}:`, errorMessage);
        errors.push({ assignmentId: assignment.id, error: errorMessage });
      }
    }

    return NextResponse.json({
      success: true,
      warningsSent,
      totalUrgent: urgentAssignments.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('SLA warning cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
