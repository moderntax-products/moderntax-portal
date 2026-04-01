/**
 * Auto-Assign Experts Cron Job
 * Finds unassigned entities that are ready for expert review and assigns them
 * to the least-loaded expert.
 * GET /api/cron/auto-assign-experts
 *
 * Expected to be called by Vercel Cron every 15 minutes with CRON_SECRET in headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';

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

    // Find entities with status '8821_signed' or 'irs_queue' that have signed_8821_url set,
    // or form_type = 'W2_INCOME'
    const { data: eligibleEntities, error: entitiesError } = await supabase
      .from('request_entities')
      .select('id, entity_name, status, signed_8821_url, form_type')
      .in('status', ['8821_signed', 'irs_queue']) as { data: any[] | null; error: any };

    if (entitiesError) {
      console.error('Failed to fetch eligible entities:', entitiesError);
      return NextResponse.json(
        { error: 'Failed to fetch entities' },
        { status: 500 }
      );
    }

    // Filter to only entities that have signed_8821_url set OR form_type = 'W2_INCOME'
    const readyEntities = (eligibleEntities || []).filter(
      (e: any) => e.signed_8821_url || e.form_type === 'W2_INCOME'
    );

    if (readyEntities.length === 0) {
      return NextResponse.json({
        success: true,
        assigned: 0,
        skipped: 0,
        message: 'No unassigned entities found',
        processedAt: new Date().toISOString(),
      });
    }

    // For each entity, check if there's already an active expert_assignment
    const entityIds = readyEntities.map((e: any) => e.id);
    const { data: existingAssignments, error: assignmentsError } = await supabase
      .from('expert_assignments')
      .select('entity_id, status')
      .in('entity_id', entityIds)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    if (assignmentsError) {
      console.error('Failed to fetch existing assignments:', assignmentsError);
      return NextResponse.json(
        { error: 'Failed to fetch existing assignments' },
        { status: 500 }
      );
    }

    const assignedEntityIds = new Set((existingAssignments || []).map((a: any) => a.entity_id));
    const unassignedEntities = readyEntities.filter((e: any) => !assignedEntityIds.has(e.id));

    if (unassignedEntities.length === 0) {
      return NextResponse.json({
        success: true,
        assigned: 0,
        skipped: readyEntities.length,
        message: 'All eligible entities already have active assignments',
        processedAt: new Date().toISOString(),
      });
    }

    // Get all experts (profiles where role='expert')
    const { data: experts, error: expertsError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'expert') as { data: any[] | null; error: any };

    if (expertsError) {
      console.error('Failed to fetch experts:', expertsError);
      return NextResponse.json(
        { error: 'Failed to fetch experts' },
        { status: 500 }
      );
    }

    if (!experts || experts.length === 0) {
      return NextResponse.json({
        success: true,
        assigned: 0,
        skipped: unassignedEntities.length,
        message: 'No experts available for assignment',
        processedAt: new Date().toISOString(),
      });
    }

    // Get the first admin to use as assigned_by
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .single() as { data: { id: string } | null; error: any };

    const assignedBy = adminProfile?.id || experts[0].id;

    // For each expert, count their active assignments
    const expertIds = experts.map((e: any) => e.id);
    const { data: activeAssignments, error: activeError } = await supabase
      .from('expert_assignments')
      .select('expert_id')
      .in('expert_id', expertIds)
      .in('status', ['assigned', 'in_progress']) as { data: any[] | null; error: any };

    if (activeError) {
      console.error('Failed to fetch active assignment counts:', activeError);
      return NextResponse.json(
        { error: 'Failed to fetch active assignments' },
        { status: 500 }
      );
    }

    // Count assignments per expert
    const assignmentCounts = new Map<string, number>();
    experts.forEach((e: any) => assignmentCounts.set(e.id, 0));
    (activeAssignments || []).forEach((a: any) => {
      assignmentCounts.set(a.expert_id, (assignmentCounts.get(a.expert_id) || 0) + 1);
    });

    let assigned = 0;
    const errors: { entityId: string; error: string }[] = [];
    // Track assignments per expert for batch notification
    const expertAssignmentMap = new Map<string, { email: string; entityNames: string[]; isEmployment: boolean[] }>();

    const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    for (const entity of unassignedEntities) {
      try {
        // Pick expert with fewest active assignments
        let minCount = Infinity;
        let bestExpert: any = null;
        for (const expert of experts) {
          const count = assignmentCounts.get(expert.id) || 0;
          if (count < minCount) {
            minCount = count;
            bestExpert = expert;
          }
        }

        if (!bestExpert) {
          errors.push({ entityId: entity.id, error: 'No expert available' });
          continue;
        }

        // Create expert_assignment
        const { error: insertError } = await supabase
          .from('expert_assignments')
          .insert({
            entity_id: entity.id,
            expert_id: bestExpert.id,
            assigned_by: assignedBy,
            status: 'assigned',
            sla_deadline: slaDeadline,
          });

        if (insertError) {
          console.error(`[auto-assign] Insert failed for entity ${entity.id}:`, insertError);
          errors.push({ entityId: entity.id, error: 'Assignment insert failed' });
          continue;
        }

        // Update entity status to 'irs_queue' if not already
        if (entity.status !== 'irs_queue') {
          await supabase
            .from('request_entities')
            .update({ status: 'irs_queue' })
            .eq('id', entity.id);
        }

        // Increment the count for load balancing of subsequent assignments
        assignmentCounts.set(bestExpert.id, (assignmentCounts.get(bestExpert.id) || 0) + 1);

        // Collect for batch notification
        const isEmployment = entity.form_type === 'W2_INCOME';
        if (!expertAssignmentMap.has(bestExpert.id)) {
          expertAssignmentMap.set(bestExpert.id, {
            email: bestExpert.email,
            entityNames: [],
            isEmployment: [],
          });
        }
        const expertData = expertAssignmentMap.get(bestExpert.id)!;
        expertData.entityNames.push(entity.entity_name);
        expertData.isEmployment.push(isEmployment);

        assigned++;
        console.log(`[auto-assign] Assigned ${entity.entity_name} to ${bestExpert.full_name || bestExpert.email}`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[auto-assign] Error assigning entity ${entity.id}:`, errorMessage);
        errors.push({ entityId: entity.id, error: errorMessage });
      }
    }

    // Send batch notifications per expert
    for (const [, expertData] of expertAssignmentMap) {
      try {
        const hasEmployment = expertData.isEmployment.some((v) => v);
        await sendExpertAssignmentNotification(
          expertData.email,
          expertData.entityNames,
          expertData.entityNames.length,
          hasEmployment
        );
      } catch (notifErr) {
        console.error(`[auto-assign] Notification error for ${expertData.email}:`, notifErr);
      }
    }

    return NextResponse.json({
      success: true,
      assigned,
      skipped: readyEntities.length - unassignedEntities.length,
      totalEligible: readyEntities.length,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Auto-assign experts cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}
