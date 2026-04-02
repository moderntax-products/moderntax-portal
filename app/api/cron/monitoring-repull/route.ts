/**
 * Monitoring Re-Pull Cron Job
 * Checks for entities due for a monitoring re-pull and creates new transcript requests
 *
 * Runs daily at 7:00 AM UTC (vercel.json)
 *
 * Flow:
 * 1. Find all active subscriptions where next_pull_date <= today
 * 2. For each, create an expert assignment using the existing signed 8821
 * 3. Update next_pull_date, pull_history, total_pulls_completed
 * 4. Bill $39.99 per pull
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';

export const maxDuration = 30;

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
    const today = new Date().toISOString().split('T')[0];

    // Find all active subscriptions due for a pull
    const { data: dueSubscriptions, error: fetchError } = await supabase
      .from('entity_monitoring' as any)
      .select(`
        *,
        request_entities (
          id, entity_name, tid, tid_kind, form_type, years,
          signed_8821_url, signer_email, signer_first_name, signer_last_name,
          request_id
        )
      `)
      .eq('status', 'active')
      .lte('next_pull_date', today) as { data: any[] | null; error: any };

    if (fetchError) {
      console.error('Failed to fetch due monitoring subscriptions:', fetchError);
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 });
    }

    if (!dueSubscriptions || dueSubscriptions.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No monitoring re-pulls due today',
        checked_date: today,
        processed: 0,
      });
    }

    let processed = 0;
    let failed = 0;
    let expired = 0;
    const results: { entity: string; status: string; next_pull?: string }[] = [];

    for (const sub of dueSubscriptions) {
      try {
        const entity = sub.request_entities as any;
        if (!entity) {
          console.error(`Monitoring ${sub.id}: entity not found`);
          failed++;
          results.push({ entity: sub.entity_id, status: 'entity_not_found' });
          continue;
        }

        // Check if subscription has expired
        if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
          await supabase
            .from('entity_monitoring' as any)
            .update({ status: 'expired' })
            .eq('id', sub.id);
          expired++;
          results.push({ entity: entity.entity_name, status: 'expired' });
          continue;
        }

        // Verify signed 8821 still exists
        if (!entity.signed_8821_url) {
          console.error(`Monitoring ${sub.id}: no signed 8821 for entity ${entity.entity_name}`);
          failed++;
          results.push({ entity: entity.entity_name, status: 'no_signed_8821' });
          continue;
        }

        // Find an available expert to assign (round-robin from active experts)
        const { data: experts } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .eq('role', 'expert');

        if (!experts || experts.length === 0) {
          console.error('No experts available for monitoring re-pull');
          failed++;
          results.push({ entity: entity.entity_name, status: 'no_experts' });
          continue;
        }

        // Simple round-robin: pick expert with fewest active assignments
        const { data: assignmentCounts } = await supabase
          .from('expert_assignments')
          .select('expert_id')
          .in('status', ['assigned', 'in_progress']);

        const countByExpert = new Map<string, number>();
        experts.forEach((e: any) => countByExpert.set(e.id, 0));
        (assignmentCounts || []).forEach((a: any) => {
          const current = countByExpert.get(a.expert_id) || 0;
          countByExpert.set(a.expert_id, current + 1);
        });

        const sortedExperts = experts.sort(
          (a: any, b: any) => (countByExpert.get(a.id) || 0) - (countByExpert.get(b.id) || 0)
        );
        const selectedExpert = sortedExperts[0] as any;

        // Create expert assignment for the re-pull
        const slaDeadline = new Date();
        slaDeadline.setHours(slaDeadline.getHours() + 48); // 48h SLA for monitoring pulls

        const { error: assignError } = await supabase
          .from('expert_assignments')
          .insert({
            entity_id: entity.id,
            expert_id: selectedExpert.id,
            assigned_by: sub.enrolled_by,
            sla_deadline: slaDeadline.toISOString(),
            status: 'assigned',
          });

        if (assignError) {
          console.error(`Failed to create assignment for monitoring ${sub.id}:`, assignError);
          failed++;
          results.push({ entity: entity.entity_name, status: 'assignment_failed' });
          continue;
        }

        // Update entity status to irs_queue for processing
        await supabase
          .from('request_entities')
          .update({ status: 'irs_queue' })
          .eq('id', entity.id);

        // Compute next pull date
        const nextPull = computeNextPull(sub.frequency, sub.custom_interval_days);

        // Update monitoring subscription
        const pullHistory = sub.pull_history || [];
        pullHistory.push({
          date: today,
          status: 'queued',
          transcript_count: 0,
          assigned_to: selectedExpert.full_name || selectedExpert.email,
        });

        await supabase
          .from('entity_monitoring' as any)
          .update({
            next_pull_date: nextPull,
            last_pull_date: today,
            total_pulls_completed: sub.total_pulls_completed + 1,
            total_billed: parseFloat(sub.total_billed) + 39.99,
            pull_history: pullHistory,
          })
          .eq('id', sub.id);

        // Notify the assigned expert
        try {
          await sendExpertAssignmentNotification(
            selectedExpert.email,
            [entity.entity_name + ' (Monitoring Re-Pull)'],
            1
          );
        } catch (emailError) {
          console.error('Failed to send expert assignment notification:', emailError);
        }

        processed++;
        results.push({
          entity: entity.entity_name,
          status: 'queued',
          next_pull: nextPull,
        });
      } catch (subError) {
        console.error(`Error processing monitoring ${sub.id}:`, subError);
        failed++;
        results.push({ entity: sub.entity_id, status: 'error' });
      }
    }

    return NextResponse.json({
      success: true,
      checked_date: today,
      total_due: dueSubscriptions.length,
      processed,
      failed,
      expired,
      results,
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Monitoring re-pull cron error:', error);
    return NextResponse.json(
      { error: 'Cron job failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}

function computeNextPull(frequency: string, customDays?: number | null): string {
  const next = new Date();
  switch (frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'custom':
      next.setDate(next.getDate() + (customDays || 30));
      break;
    default:
      next.setMonth(next.getMonth() + 1);
  }
  return next.toISOString().split('T')[0];
}
