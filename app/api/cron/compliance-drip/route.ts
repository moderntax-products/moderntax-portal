/**
 * Compliance Drip Cron
 * Runs daily — sends the next stage email for entities in the drip sequence.
 * Also enrolls newly flagged entities that don't have a drip record yet.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { classifyFlags, sendDripEmail, getNextEmailDueDate, DRIP_SCHEDULE_DAYS } from '@/lib/compliance-drip';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const now = new Date();
  let enrolled = 0;
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  // --- Step 1: Enroll new flagged entities ---
  // Find completed entities with compliance flags that don't have a drip record yet
  const { data: flaggedEntities } = await supabase
    .from('request_entities')
    .select('id, entity_name, gross_receipts, signer_email, signer_first_name')
    .eq('status', 'completed')
    .not('gross_receipts', 'is', null) as { data: any[] | null; error: any };

  if (flaggedEntities) {
    // Get existing drip entity_ids
    const { data: existingDrips } = await supabase
      .from('compliance_drip')
      .select('entity_id') as { data: any[] | null; error: any };
    const enrolledIds = new Set((existingDrips || []).map((d: any) => d.entity_id));

    for (const entity of flaggedEntities) {
      if (enrolledIds.has(entity.id)) continue;
      if (!entity.signer_email) continue;
      if (!entity.gross_receipts || typeof entity.gross_receipts !== 'object') continue;

      // Check if entity has CRITICAL or WARNING flags
      const hasFlags = Object.values(entity.gross_receipts).some(
        (val: any) => val?.severity && ['CRITICAL', 'WARNING'].includes(val.severity)
      );
      if (!hasFlags) continue;

      const classification = classifyFlags(entity.gross_receipts);

      // Create drip record
      const { error: insertErr } = await supabase
        .from('compliance_drip')
        .insert({
          entity_id: entity.id,
          flag_category: classification.category,
          flag_severity: classification.severity,
          balance_due: classification.balanceDue || null,
          accrued_penalty: classification.penalty || null,
          accrued_interest: classification.interest || null,
          total_exposure: classification.totalExposure || null,
          drip_stage: 0,
          next_email_due_at: now.toISOString(),
          signer_email: entity.signer_email,
          signer_name: entity.signer_first_name || null,
          entity_name: entity.entity_name,
        });

      if (insertErr) {
        console.error(`[compliance-drip] Failed to enroll ${entity.entity_name}:`, insertErr);
        errors++;
      } else {
        enrolled++;
      }
    }
  }

  // --- Step 2: Send due drip emails ---
  const { data: dueRecords } = await supabase
    .from('compliance_drip')
    .select('*')
    .eq('unsubscribed', false)
    .eq('consultation_booked', false)
    .lt('drip_stage', DRIP_SCHEDULE_DAYS.length)
    .lte('next_email_due_at', now.toISOString())
    .order('next_email_due_at', { ascending: true })
    .limit(50) as { data: any[] | null; error: any };

  if (dueRecords) {
    for (const drip of dueRecords) {
      // Fetch flags from the entity's gross_receipts
      const { data: entity } = await supabase
        .from('request_entities')
        .select('gross_receipts')
        .eq('id', drip.entity_id)
        .single() as { data: any; error: any };

      if (!entity?.gross_receipts) {
        skipped++;
        continue;
      }

      const classification = classifyFlags(entity.gross_receipts);
      const success = await sendDripEmail(drip.drip_stage, drip, classification.allFlags);

      if (success) {
        const stageField = `email_${drip.drip_stage}_sent_at`;
        const nextDue = getNextEmailDueDate(drip.drip_stage, now);
        const nextStage = drip.drip_stage + 1;

        await supabase
          .from('compliance_drip')
          .update({
            [stageField]: now.toISOString(),
            last_email_sent_at: now.toISOString(),
            drip_stage: nextStage,
            next_email_due_at: nextStage < DRIP_SCHEDULE_DAYS.length ? nextDue.toISOString() : null,
            updated_at: now.toISOString(),
          })
          .eq('id', drip.id);

        sent++;
      } else {
        errors++;
      }
    }
  }

  console.log(`[compliance-drip] Enrolled: ${enrolled}, Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`);

  return NextResponse.json({
    success: true,
    enrolled,
    sent,
    skipped,
    errors,
    timestamp: now.toISOString(),
  });
}
