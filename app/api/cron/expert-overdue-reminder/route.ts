/**
 * Expert Overdue Reminder Cron Job
 * Sends daily reminders to experts with past-due assignments and
 * an accountability digest to admins showing which expert has what stuck.
 * GET /api/cron/expert-overdue-reminder
 *
 * Checks for:
 * - Expert assignments where sla_deadline < now (past-due)
 * - Groups by expert to send one consolidated email per expert
 * - Sends admin digest showing expert-level accountability
 *
 * Scheduled: Daily at 9:00 AM and 2:00 PM UTC (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import {
  sendExpertOverdueReminder,
  sendAdminExpertAccountabilityDigest,
} from '@/lib/sendgrid';

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
    const now = new Date();

    // Find all active expert assignments that are past SLA deadline
    const { data: overdueAssignments, error: assignmentsError } = await supabase
      .from('expert_assignments')
      .select(`
        id, sla_deadline, status, created_at, expert_id, entity_id,
        expert_profile:profiles!expert_assignments_expert_id_fkey(id, email, full_name),
        request_entities(id, entity_name, status, request_id)
      `)
      .in('status', ['assigned', 'in_progress'])
      .lt('sla_deadline', now.toISOString()) as { data: any[] | null; error: any };

    if (assignmentsError) {
      console.error('Failed to fetch overdue assignments:', assignmentsError);
      return NextResponse.json(
        { error: 'Failed to fetch overdue assignments' },
        { status: 500 }
      );
    }

    if (!overdueAssignments || overdueAssignments.length === 0) {
      return NextResponse.json({
        success: true,
        expertReminders: 0,
        adminDigests: 0,
        message: 'No overdue assignments found',
        processedAt: now.toISOString(),
      });
    }

    // Get request details (loan numbers + client IDs) in bulk
    const requestIds = Array.from(new Set(
      overdueAssignments
        .map((a: any) => a.request_entities?.request_id)
        .filter(Boolean)
    ));

    const { data: requests } = await supabase
      .from('requests')
      .select('id, loan_number, client_id')
      .in('id', requestIds) as { data: any[] | null; error: any };

    const requestMap = new Map<string, { loan_number: string; client_id: string }>();
    (requests || []).forEach((r: any) => {
      requestMap.set(r.id, { loan_number: r.loan_number || 'N/A', client_id: r.client_id });
    });

    // Get client names in bulk
    const clientIds = Array.from(new Set(
      (requests || []).map((r: any) => r.client_id).filter(Boolean)
    ));

    const { data: clients } = await supabase
      .from('clients')
      .select('id, name')
      .in('id', clientIds) as { data: any[] | null; error: any };

    const clientMap = new Map<string, string>();
    (clients || []).forEach((c: any) => {
      clientMap.set(c.id, c.name);
    });

    // Also get total active assignments per expert (for the admin digest "X overdue / Y total")
    const expertIds = Array.from(new Set(overdueAssignments.map((a: any) => a.expert_id)));
    const { data: allActiveAssignments } = await supabase
      .from('expert_assignments')
      .select('expert_id')
      .in('expert_id', expertIds)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    const totalAssignmentCounts = new Map<string, number>();
    (allActiveAssignments || []).forEach((a: any) => {
      totalAssignmentCounts.set(a.expert_id, (totalAssignmentCounts.get(a.expert_id) || 0) + 1);
    });

    // Group overdue assignments by expert
    const expertGroups = new Map<string, {
      expertId: string;
      expertName: string;
      expertEmail: string;
      entities: {
        entityName: string;
        clientName: string;
        stuckDays: number;
        loanNumber: string;
        status: string;
      }[];
    }>();

    for (const assignment of overdueAssignments) {
      const expertId = assignment.expert_id;
      const expertEmail = assignment.expert_profile?.email;
      const expertName = assignment.expert_profile?.full_name || expertEmail || 'Unknown Expert';
      const entityName = assignment.request_entities?.entity_name || 'Unknown Entity';
      const entityStatus = assignment.request_entities?.status || 'unknown';
      const requestId = assignment.request_entities?.request_id;
      const reqInfo = requestId ? requestMap.get(requestId) : undefined;
      const clientName = reqInfo?.client_id ? (clientMap.get(reqInfo.client_id) || 'Unknown Client') : 'Unknown Client';
      const loanNumber = reqInfo?.loan_number || 'N/A';

      // Calculate days overdue (from SLA deadline, not assignment date)
      const slaDeadline = new Date(assignment.sla_deadline);
      const stuckDays = Math.max(1, Math.floor((now.getTime() - slaDeadline.getTime()) / (1000 * 60 * 60 * 24)));

      if (!expertGroups.has(expertId)) {
        expertGroups.set(expertId, {
          expertId,
          expertName,
          expertEmail,
          entities: [],
        });
      }

      expertGroups.get(expertId)!.entities.push({
        entityName,
        clientName,
        stuckDays,
        loanNumber,
        status: entityStatus,
      });
    }

    // Send expert reminders (parallel batches of 3)
    let expertReminders = 0;
    const expertErrors: { email: string; error: string }[] = [];
    const expertEntries = Array.from(expertGroups.values());

    const BATCH_SIZE = 3;
    for (let i = 0; i < expertEntries.length; i += BATCH_SIZE) {
      const batch = expertEntries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (expert) => {
          if (!expert.expertEmail) return null;
          await sendExpertOverdueReminder(
            expert.expertEmail,
            expert.expertName,
            expert.entities
          );
          console.log(
            `[expert-overdue] Sent reminder to ${expert.expertName} (${expert.expertEmail}): ${expert.entities.length} overdue`
          );
          return expert.expertEmail;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          expertReminders++;
        } else if (result.status === 'rejected') {
          const errorMessage = result.reason instanceof Error ? result.reason.message : 'Unknown error';
          expertErrors.push({ email: 'unknown', error: errorMessage });
        }
      }
    }

    // Send admin accountability digest
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('role', 'admin')
      .not('email', 'is', null) as { data: { id: string; email: string }[] | null; error: any };

    let adminDigests = 0;
    const expertSummaries = expertEntries.map((expert) => ({
      expertName: expert.expertName,
      expertEmail: expert.expertEmail,
      overdueCount: expert.entities.length,
      totalAssigned: totalAssignmentCounts.get(expert.expertId) || expert.entities.length,
      entities: expert.entities,
    }));

    if (admins && admins.length > 0) {
      const adminResults = await Promise.allSettled(
        admins.map(async (admin) => {
          await sendAdminExpertAccountabilityDigest(admin.email, expertSummaries);
          return admin.email;
        })
      );

      for (const result of adminResults) {
        if (result.status === 'fulfilled' && result.value) {
          adminDigests++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      expertReminders,
      adminDigests,
      totalOverdue: overdueAssignments.length,
      expertBreakdown: expertEntries.map((e) => ({
        expert: e.expertName,
        overdueCount: e.entities.length,
        entities: e.entities.map((ent) => ent.entityName),
      })),
      processedAt: now.toISOString(),
      errors: expertErrors.length > 0 ? expertErrors : undefined,
    });
  } catch (error) {
    console.error('Expert overdue reminder cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
