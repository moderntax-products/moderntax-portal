/**
 * Monitoring Re-Pull Cron Job
 *
 * Runs daily at 7:00 AM UTC (vercel.json).
 *
 * Flow per due subscription:
 *   1. Create a NEW request with intake_method='monitoring_repull' so the
 *      pull lifecycle is a first-class object — visible in admin queue,
 *      visible in /request/[id], invoiced via the normal entity flow.
 *   2. Clone the entity (same TID, name, address, form, expanded year range)
 *      with status='8821_signed' (skipping the signature collection step
 *      since the original 8821 already authorizes us).
 *   3. Auto-assign an expert to the new entity (round-robin by load).
 *   4. Update entity_monitoring metadata: pull_history append,
 *      total_pulls_completed += 1, total_billed += per_pull_fee,
 *      next_pull_date advanced by cadence.
 *   5. Bill $59.98 (PER_PULL_FEE) — auto-invoice cron picks up the new
 *      entity's eventual completion at the monitoring rate via
 *      intake_method='monitoring_repull'.
 *
 * Audit trail (Robert/Enterprise Bank Apr 27 ask): every pull is recorded
 * to entity_monitoring.pull_history with billable: true|false flag. A pull
 * that returns "no record found" stays in history (audit-defense paper
 * trail) but is NOT billed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { sendExpertAssignmentNotification } from '@/lib/sendgrid';

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
    const today = new Date().toISOString().split('T')[0];

    // Find all active subscriptions due for a pull. Pull the originating
    // entity AND its owning request so we can copy client_id + loan_number.
    const { data: dueSubscriptions, error: fetchError } = await supabase
      .from('entity_monitoring' as any)
      .select(`
        *,
        request_entities (
          id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code,
          signed_8821_url, signer_email, signer_first_name, signer_last_name,
          request_id,
          requests ( id, client_id, loan_number, requested_by )
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

        // ============================================================
        // CREATE A NEW REQUEST per pull — first-class lifecycle object
        // so this monitoring pull shows up in the admin queue, in the
        // manager's request list, and in the per-entity rate-billed
        // line items on the next invoice.
        // ============================================================
        const owningRequest = entity.requests as any;
        if (!owningRequest) {
          console.error(`Monitoring ${sub.id}: entity ${entity.id} has no owning request`);
          failed++;
          results.push({ entity: entity.entity_name, status: 'orphan_entity' });
          continue;
        }

        const monitoringLoanNumber = `MON-${entity.entity_name.slice(0, 24).replace(/[^a-zA-Z0-9]/g, '')}-${today}`;
        const { data: newRequest, error: reqErr } = await supabase
          .from('requests')
          .insert({
            client_id: owningRequest.client_id,
            requested_by: sub.enrolled_by,
            loan_number: monitoringLoanNumber,
            intake_method: 'monitoring_repull',
            status: '8821_signed', // skip signature step — original 8821 covers
            notes: `Auto-created by monitoring re-pull cron on ${today}. Source enrollment: ${sub.id}. Source entity: ${entity.id} (${entity.entity_name}). 8821 reused from prior submission. Cadence: ${sub.frequency}.`,
          })
          .select('id')
          .single() as { data: { id: string } | null; error: any };

        if (reqErr || !newRequest) {
          console.error(`Failed to create request for monitoring ${sub.id}:`, reqErr?.message);
          failed++;
          results.push({ entity: entity.entity_name, status: 'request_create_failed' });
          continue;
        }

        // Clone the entity into the new request (same TID + 8821, fresh row
        // so its eventual completion is its own billable line item).
        const { data: clonedEntity, error: cloneErr } = await supabase
          .from('request_entities')
          .insert({
            request_id: newRequest.id,
            entity_name: entity.entity_name,
            tid: entity.tid,
            tid_kind: entity.tid_kind,
            form_type: entity.form_type,
            years: entity.years,
            address: entity.address,
            city: entity.city,
            state: entity.state,
            zip_code: entity.zip_code,
            signed_8821_url: entity.signed_8821_url,
            signer_email: entity.signer_email,
            signer_first_name: entity.signer_first_name,
            signer_last_name: entity.signer_last_name,
            status: 'irs_queue',
            signature_created_at: new Date().toISOString(),
            gross_receipts: {
              source_monitoring_id: sub.id,
              source_entity_id: entity.id,
              monitoring_pull_number: (sub.total_pulls_completed || 0) + 1,
            },
          })
          .select('id')
          .single() as { data: { id: string } | null; error: any };

        if (cloneErr || !clonedEntity) {
          console.error(`Failed to clone entity for monitoring ${sub.id}:`, cloneErr?.message);
          // Roll back the request to keep things clean
          await supabase.from('requests').delete().eq('id', newRequest.id);
          failed++;
          results.push({ entity: entity.entity_name, status: 'entity_clone_failed' });
          continue;
        }

        // Create expert assignment on the CLONED entity
        const slaDeadline = new Date();
        slaDeadline.setHours(slaDeadline.getHours() + 48); // 48h SLA for monitoring pulls

        const { error: assignError } = await supabase
          .from('expert_assignments')
          .insert({
            entity_id: clonedEntity.id,
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

        // Compute next pull date
        const nextPull = computeNextPull(sub.frequency, sub.custom_interval_days);

        // Update monitoring subscription audit history. Note: 'queued' status
        // means we attempted; not yet known whether IRS will return new data.
        // The completion webhook will flip the entry to 'completed' or
        // 'no_record_found' and toggle billable accordingly. Robert/Enterprise
        // Bank Apr 27 ask: every pull stays in history for audit defense
        // even if no data is returned.
        const PER_PULL_FEE = 59.98;
        const pullHistory = Array.isArray(sub.pull_history) ? sub.pull_history : [];
        pullHistory.push({
          date: today,
          status: 'queued',
          new_request_id: newRequest.id,
          new_entity_id: clonedEntity.id,
          assigned_to: selectedExpert.full_name || selectedExpert.email,
          transcript_count: 0,
          billable: true,           // assume billable; flip to false on no_record_found
          billed_amount: PER_PULL_FEE,
        });

        await supabase
          .from('entity_monitoring' as any)
          .update({
            next_pull_date: nextPull,
            last_pull_date: today,
            total_pulls_completed: (sub.total_pulls_completed || 0) + 1,
            total_billed: parseFloat(sub.total_billed || '0') + PER_PULL_FEE,
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
