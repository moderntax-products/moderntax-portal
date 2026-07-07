/**
 * Auto-batch experts (formerly auto-assign-experts).
 *
 * Replaces the old per-entity direct-assignment cron with the supply-demand
 * batch workflow (Matt 2026-05-16 directive). Every 30 minutes:
 *
 *   1. Find eligible entities — 8821_signed or irs_queue, has signed 8821
 *      (or is W2_INCOME or comes from API intake), no active assignment.
 *   2. Group by client_id so batches stay client-coherent (one expert
 *      handles all of a single client's entities in one batch when possible).
 *   3. Find available experts — role=expert, complete designee creds,
 *      no current pending_acceptance/accepted batch.
 *   4. Round-robin offer batches of up to 5 entities per available expert.
 *   5. createBatch() per pairing — validates each one + creates the offer.
 *
 * GET /api/cron/auto-assign-experts
 * Auth: Vercel cron Bearer secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { createBatch, BATCH_MAX_ENTITIES } from '@/lib/assignment-batch';
import { validateExpertDesigneeCreds } from '@/lib/8821-pdf';

export const maxDuration = 60;
export const runtime = 'nodejs';

interface PoolEntity {
  id: string;
  request_id: string;
  client_id: string;
  entity_name: string;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const admin = createAdminClient();
  const skipped: Record<string, number> = {};

  // ─── 1. Eligible entities ────────────────────────────────────────────────
  const { data: rawEligible } = await admin
    .from('request_entities')
    .select('id, entity_name, status, signed_8821_url, signature_id, gross_receipts, form_type, request_id')
    .in('status', ['8821_signed', 'irs_queue']) as { data: any[] | null };

  const eligible = rawEligible || [];
  if (eligible.length === 0) {
    return NextResponse.json({ success: true, batches_created: 0, entities_offered: 0, note: 'no eligible entities' });
  }

  // Determine which requests are API-intake (they skip the 8821 flow internally)
  const requestIds = [...new Set(eligible.map(e => e.request_id))];
  const { data: requests } = await admin
    .from('requests')
    .select('id, client_id, intake_method')
    .in('id', requestIds) as { data: any[] | null };
  const apiRequestIds = new Set((requests || []).filter(r => r.intake_method === 'api').map(r => r.id));
  const requestToClient = new Map<string, string>((requests || []).map(r => [r.id, r.client_id]));

  // Entity is "ready" for assignment only when its 8821 is confirmed complete:
  //  - API intake + W2_INCOME skip the 8821 flow entirely.
  //  - App-generated 8821s (Dropbox Sign → signature_id) are inherently valid.
  //  - UPLOADED 8821s (Centerstone flat-rate bulk-attach / single-PDF fallback,
  //    signature_id null) must pass the vision completeness check stamped by the
  //    verify-8821-completeness cron (right taxpayer TIN, signed, ModernTax
  //    designee). Held until verified so an expert is never handed a blank,
  //    mismatched, or unsigned form.
  let heldForIncomplete8821 = 0;
  const ready = eligible.filter(e => {
    if (apiRequestIds.has(e.request_id) || e.form_type === 'W2_INCOME') return true;
    if (!e.signed_8821_url) return false;
    if (e.signature_id) return true; // app-generated (Dropbox Sign)
    const verified = e.gross_receipts?.eightyone_check?.ok === true; // uploaded → must be verified
    if (!verified) heldForIncomplete8821++;
    return verified;
  });
  skipped.not_ready_for_assignment = eligible.length - ready.length;
  skipped.held_8821_incomplete = heldForIncomplete8821;

  // Filter out anything that already has an active assignment
  const { data: activeAssns } = await admin
    .from('expert_assignments')
    .select('entity_id')
    .in('entity_id', ready.map(e => e.id))
    .in('status', ['pending_acceptance', 'assigned', 'in_progress']);
  const blockedIds = new Set((activeAssns || []).map((a: any) => a.entity_id));
  const pool: PoolEntity[] = ready
    .filter(e => !blockedIds.has(e.id))
    .map(e => ({
      id: e.id,
      request_id: e.request_id,
      client_id: requestToClient.get(e.request_id) || '',
      entity_name: e.entity_name,
    }))
    .filter(e => e.client_id); // drop orphans we can't bucket
  skipped.already_assigned = ready.length - pool.length - (skipped.not_ready_for_assignment || 0);

  if (pool.length === 0) {
    return NextResponse.json({ success: true, batches_created: 0, entities_offered: 0, skipped });
  }

  // ─── 2. Available experts ────────────────────────────────────────────────
  const { data: experts } = await admin
    .from('profiles')
    .select('id, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('role', 'expert') as { data: any[] | null };

  const credsComplete = (experts || []).filter(e => validateExpertDesigneeCreds(e).length === 0);
  skipped.experts_incomplete_creds = (experts || []).length - credsComplete.length;

  if (credsComplete.length === 0) {
    return NextResponse.json({
      success: true,
      batches_created: 0,
      entities_offered: 0,
      skipped: { ...skipped, no_credentialed_experts: 1 },
    });
  }

  // Drop experts who already have a pending/accepted batch
  const { data: busyBatches } = await admin
    .from('assignment_batches')
    .select('expert_id')
    .in('status', ['pending_acceptance', 'accepted']);
  const busyExperts = new Set((busyBatches || []).map((b: any) => b.expert_id));
  const available = credsComplete.filter(e => !busyExperts.has(e.id));
  skipped.experts_busy = credsComplete.length - available.length;

  if (available.length === 0) {
    return NextResponse.json({
      success: true,
      batches_created: 0,
      entities_offered: 0,
      skipped,
      note: 'all credentialed experts already have an active batch — try again in 30 min',
    });
  }

  // ─── 3. Group pool by client (client-coherent batches) ───────────────────
  const byClient = new Map<string, PoolEntity[]>();
  for (const e of pool) {
    const arr = byClient.get(e.client_id) || [];
    arr.push(e);
    byClient.set(e.client_id, arr);
  }

  // Flatten into batches of up to BATCH_MAX_ENTITIES, preserving client grouping
  const batchesToOffer: PoolEntity[][] = [];
  for (const [, clientEntities] of byClient) {
    for (let i = 0; i < clientEntities.length; i += BATCH_MAX_ENTITIES) {
      batchesToOffer.push(clientEntities.slice(i, i + BATCH_MAX_ENTITIES));
    }
  }

  // ─── 4. Round-robin offer to available experts ───────────────────────────
  const created: { batchId: string; expertEmail: string; entityCount: number; entityNames: string[] }[] = [];
  const errors: { expertEmail: string; entityIds: string[]; error: string }[] = [];

  // Cap: one batch per expert per cron run (matches the one-active-batch rule)
  const offerCount = Math.min(available.length, batchesToOffer.length);
  for (let i = 0; i < offerCount; i++) {
    const expert = available[i];
    const batchEntities = batchesToOffer[i];

    const result = await createBatch(admin, {
      expertId: expert.id,
      entityIds: batchEntities.map(e => e.id),
      offeredBy: expert.id, // self-attributed since cron is system-actor; the
                            // batch's offered_by is informational only and
                            // expert_id is the authoritative recipient.
      notes: 'Auto-batched by cron',
    });

    if (result.ok && result.batch) {
      created.push({
        batchId: result.batch.id,
        expertEmail: expert.email,
        entityCount: batchEntities.length,
        entityNames: batchEntities.map(e => e.entity_name),
      });
      // Notify expert (best-effort)
      try {
        const { sendExpertAssignmentNotification } = await import('@/lib/sendgrid');
        await sendExpertAssignmentNotification(
          expert.email,
          batchEntities.map(e => e.entity_name),
          batchEntities.length,
        );
      } catch (notifyErr) {
        console.warn('[auto-batch] notification failed (non-fatal):', notifyErr);
      }
    } else {
      errors.push({
        expertEmail: expert.email,
        entityIds: batchEntities.map(e => e.id),
        error: result.error || 'unknown',
      });
    }
  }

  return NextResponse.json({
    success: true,
    batches_created: created.length,
    entities_offered: created.reduce((s, c) => s + c.entityCount, 0),
    available_experts: available.length,
    pending_pool_size: pool.length,
    skipped,
    created,
    errors,
    processed_at: new Date().toISOString(),
  });
}
