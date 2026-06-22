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
import { extractDesigneeCafs, normalizeCaf } from '@/lib/verify-8821-designee';

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
    .select('id, entity_name, status, signed_8821_url, form_type, request_id')
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

  // Entity is "ready" if it has a signed 8821 OR is W2_INCOME OR is API-intake
  const ready = eligible.filter(e =>
    e.signed_8821_url || e.form_type === 'W2_INCOME' || apiRequestIds.has(e.request_id),
  );
  skipped.not_ready_for_assignment = eligible.length - ready.length;

  // Filter out anything that already has an active assignment
  const { data: activeAssns } = await admin
    .from('expert_assignments')
    .select('entity_id')
    .in('entity_id', ready.map(e => e.id))
    .in('status', ['pending_acceptance', 'assigned', 'in_progress']);
  const blockedIds = new Set((activeAssns || []).map((a: any) => a.entity_id));
  let pool: PoolEntity[] = ready
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

  // Experts who already let an offer for a given entity EXPIRE or DECLINED it.
  // We must never re-offer the same entity to the same expert — otherwise a
  // designated expert who doesn't accept gets re-offered every cron run forever
  // (the LaTonya Holmes loop: pending→expired→pending→… hourly, wasting jobs).
  // Excluding them makes assignment "offer once per verifier, then move to the
  // next available verifier."
  const poolIds = pool.map(e => e.id);
  const declinedExpertsByEntity = new Map<string, Set<string>>();
  if (poolIds.length > 0) {
    const { data: priorAssns } = await admin
      .from('expert_assignments')
      .select('entity_id, expert_id, status')
      .in('entity_id', poolIds)
      .in('status', ['expired', 'declined']) as { data: any[] | null };
    for (const a of priorAssns || []) {
      const set = declinedExpertsByEntity.get(a.entity_id) || new Set<string>();
      set.add(a.expert_id);
      declinedExpertsByEntity.set(a.entity_id, set);
    }
  }
  const hasDeclined = (entityId: string, expertId: string): boolean =>
    declinedExpertsByEntity.get(entityId)?.has(expertId) === true;

  // ─── Designee-based auto-assignment (deterministic, no manual work) ──────
  // The 8821 names the expert via their CAF as a designee — so assign straight
  // to that expert. Runs BEFORE the busy/round-robin logic so a designated
  // expert receives their entity even if they already have a batch. ModernTax's
  // shared master CAF is excluded (it's a designee on every form, not a match).
  const MASTER_CAF = normalizeCaf('0316-30210R');
  const cafToExpert = new Map<string, any>();
  for (const ex of experts || []) {
    const n = normalizeCaf(ex.caf_number);
    if (n && n !== MASTER_CAF) cafToExpert.set(n, ex);
  }
  const signedUrlById = new Map<string, string>(
    ready.filter(e => e.signed_8821_url).map(e => [e.id, e.signed_8821_url as string]),
  );
  const designeeByExpert = new Map<string, { expert: any; entities: PoolEntity[] }>();
  if (cafToExpert.size > 0) {
    for (const e of pool) {
      const url = signedUrlById.get(e.id);
      if (!url) continue; // W2/API entities have no 8821 to read — leave for round-robin
      try {
        const dl = await admin.storage.from('uploads').download(url);
        if (!dl.data) continue;
        const cafs = await extractDesigneeCafs(Buffer.from(await dl.data.arrayBuffer()));
        const matched = cafs.map((c: string) => cafToExpert.get(normalizeCaf(c))).find(Boolean);
        // Don't re-offer to a designee who already let this entity's offer
        // expire/declined it — leave it for round-robin (next available verifier).
        if (matched && !hasDeclined(e.id, matched.id)) {
          const slot = designeeByExpert.get(matched.id) || { expert: matched, entities: [] };
          slot.entities.push(e);
          designeeByExpert.set(matched.id, slot);
        } else if (matched) {
          skipped.designee_already_declined = (skipped.designee_already_declined || 0) + 1;
        }
      } catch (err) {
        console.error('[auto-assign] designee parse failed for', e.id, err instanceof Error ? err.message : err);
      }
    }
  }
  const designeeAssignedIds = new Set<string>();
  let designeeAssignedCount = 0;
  for (const { expert, entities } of designeeByExpert.values()) {
    for (let i = 0; i < entities.length; i += BATCH_MAX_ENTITIES) {
      const chunk = entities.slice(i, i + BATCH_MAX_ENTITIES);
      const result = await createBatch(admin, {
        expertId: expert.id,
        entityIds: chunk.map(c => c.id),
        offeredBy: expert.id,
        notes: 'Auto-assigned by 8821 designee',
      });
      if (result.ok) {
        chunk.forEach(c => designeeAssignedIds.add(c.id));
        designeeAssignedCount += chunk.length;
        try {
          const { sendExpertAssignmentNotification } = await import('@/lib/sendgrid');
          await sendExpertAssignmentNotification(expert.email, chunk.map(c => c.entity_name), chunk.length);
        } catch (notifyErr) {
          console.warn('[auto-assign] designee notification failed (non-fatal):', notifyErr);
        }
      } else {
        console.error('[auto-assign] designee createBatch failed for', expert.email, ':', result.error);
      }
    }
  }
  // Designee-assigned entities leave the pool before the round-robin.
  pool = pool.filter(e => !designeeAssignedIds.has(e.id));
  skipped.designee_assigned = designeeAssignedCount;

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
    // Never re-offer an entity to an expert who already expired/declined it —
    // those stay in the pool for a different verifier on a later run.
    const batchEntities = batchesToOffer[i].filter(e => !hasDeclined(e.id, expert.id));
    if (batchEntities.length === 0) {
      skipped.roundrobin_all_previously_declined = (skipped.roundrobin_all_previously_declined || 0) + 1;
      continue;
    }

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
