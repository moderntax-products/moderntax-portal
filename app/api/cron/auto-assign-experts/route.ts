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

/** Normalize a TID to digits only, so "87-3050359" and "873050359" match. */
const normalizeTid = (t: string | null | undefined): string => (t || '').replace(/\D/g, '');

interface PoolEntity {
  id: string;
  request_id: string;
  client_id: string;
  entity_name: string;
}

/**
 * Assign a single entity to a specific expert, reaching them even if busy.
 * If the expert already has an active batch we add the entity straight into
 * it (status mirrors the batch — 'assigned' on an accepted batch, otherwise
 * part of the still-pending offer); if they're free we open a fresh one-entity
 * batch. Used by the prior-completer-by-TIN path, which deliberately routes a
 * re-pull back to the expert who already holds IRS authorization for that EIN.
 */
async function assignEntityToExpert(
  admin: ReturnType<typeof createAdminClient>,
  expertId: string,
  entityId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: batch } = await admin
    .from('assignment_batches')
    .select('id, status')
    .eq('expert_id', expertId)
    .in('status', ['pending_acceptance', 'accepted'])
    .order('offered_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { id: string; status: string } | null };

  if (!batch) {
    const res = await createBatch(admin, {
      expertId,
      entityIds: [entityId],
      offeredBy: expertId,
      notes: 'Auto-assigned to prior completer of this TIN (TDS-first)',
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  const now = new Date();
  const { error } = await (admin.from('expert_assignments') as any).insert({
    entity_id: entityId,
    expert_id: expertId,
    assigned_by: expertId,
    batch_id: batch.id,
    assigned_at: now.toISOString(),
    sla_deadline: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    sla_business_hours: 24,
    status: batch.status === 'accepted' ? 'assigned' : 'pending_acceptance',
  });
  return error ? { ok: false, error: error.message } : { ok: true };
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

  // ─── Prior-completer-by-TIN path (highest priority — Matt 2026-06-23) ─────
  // If an expert previously COMPLETED an order for this entity's TIN, route the
  // re-pull straight back to them: their CAF is already on record with the IRS
  // for that EIN, so they retrieve via TDS (Transcript Delivery System) INSTANTLY
  // — no new PPS call / SOR mailbox. We reach them even if they're busy (add to
  // their active batch). New / first-time TINs (no prior completer) fall through
  // to the round-robin below untouched, so the API + new-order pipeline is
  // unaffected. Runs BEFORE the busy/available computation so any batch we open
  // here is reflected when the round-robin picks experts.
  const expertById = new Map((experts || []).map(e => [e.id, e]));
  const credsCompleteIds = new Set(credsComplete.map(e => e.id));

  // TIDs (normalized EINs/SSNs) for the current pool.
  const { data: poolTidRows } = await admin
    .from('request_entities')
    .select('id, tid')
    .in('id', pool.map(e => e.id)) as { data: { id: string; tid: string | null }[] | null };
  const tidByEntity = new Map<string, string>();
  for (const r of poolTidRows || []) {
    const t = normalizeTid(r.tid);
    if (t) tidByEntity.set(r.id, t);
  }
  const poolTids = [...new Set([...tidByEntity.values()])];

  // For each pool TID, find who most-recently COMPLETED an order on that TID.
  const priorCompleterByTid = new Map<string, { expertId: string; when: number }>();
  if (poolTids.length > 0) {
    const { data: sameTidEnts } = await admin
      .from('request_entities')
      .select('id, tid')
      .in('tid', poolTids) as { data: { id: string; tid: string | null }[] | null };
    const tidOfEntity = new Map<string, string>();
    for (const r of sameTidEnts || []) {
      const t = normalizeTid(r.tid);
      if (t) tidOfEntity.set(r.id, t);
    }
    const sameTidEntityIds = [...tidOfEntity.keys()];
    if (sameTidEntityIds.length > 0) {
      const { data: completedAssns } = await admin
        .from('expert_assignments')
        .select('entity_id, expert_id, completed_at, updated_at')
        .eq('status', 'completed')
        .in('entity_id', sameTidEntityIds) as { data: any[] | null };
      for (const a of completedAssns || []) {
        const t = tidOfEntity.get(a.entity_id);
        if (!t) continue;
        const when = Date.parse(a.completed_at || a.updated_at || '') || 0;
        const cur = priorCompleterByTid.get(t);
        if (!cur || when > cur.when) priorCompleterByTid.set(t, { expertId: a.expert_id, when });
      }
    }
  }

  // One admin profile authors the auto-posted TDS-first instruction note
  // (entity_notes only permits 'admin'/'expert' authors).
  const { data: noteAuthor } = await admin
    .from('profiles')
    .select('id')
    .eq('role', 'admin')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle() as { data: { id: string } | null };

  const TDS_FIRST_BODY =
    'RETRIEVAL METHOD — TDS FIRST: you previously completed an order for this taxpayer’s TIN, so ' +
    'ModernTax’s authorization (your CAF) is already on record with the IRS for this EIN. Check your IRS ' +
    'e-Services TDS (Transcript Delivery System) for INSTANT retrieval first. Only fall back to an IRS PPS ' +
    'call + SOR mailbox if TDS does not return the transcripts.';

  const priorAssignedIds = new Set<string>();
  const priorAssigned: { expertEmail: string; entityName: string }[] = [];
  for (const e of pool) {
    const t = tidByEntity.get(e.id);
    if (!t) continue;
    const match = priorCompleterByTid.get(t);
    if (!match) continue;
    const expert = expertById.get(match.expertId);
    if (!expert || !credsCompleteIds.has(expert.id)) continue; // completer gone/uncredentialed → round-robin
    const res = await assignEntityToExpert(admin, expert.id, e.id);
    if (!res.ok) {
      console.error('[auto-assign] prior-completer assign failed for', e.id, res.error);
      continue;
    }
    priorAssignedIds.add(e.id);
    priorAssigned.push({ expertEmail: expert.email, entityName: e.entity_name });
    if (noteAuthor) {
      const { error: noteErr } = await (admin.from('entity_notes') as any).insert({
        entity_id: e.id,
        author_id: noteAuthor.id,
        author_role: 'admin',
        author_name: 'ModernTax Auto-Assign',
        body: TDS_FIRST_BODY,
        kind: 'instruction',
      });
      if (noteErr) console.warn('[auto-assign] TDS-first note failed:', noteErr.message);
    }
    try {
      const { sendExpertAssignmentNotification } = await import('@/lib/sendgrid');
      await sendExpertAssignmentNotification(expert.email, [e.entity_name], 1);
    } catch (notifyErr) {
      console.warn('[auto-assign] prior-completer notification failed (non-fatal):', notifyErr);
    }
  }
  pool = pool.filter(e => !priorAssignedIds.has(e.id));
  skipped.prior_completer_assigned = priorAssigned.length;

  if (pool.length === 0) {
    return NextResponse.json({
      success: true,
      batches_created: priorAssigned.length,
      entities_offered: priorAssigned.length,
      prior_completer_assigned: priorAssigned,
      skipped,
      note: 'all eligible entities routed to prior completers',
      processed_at: new Date().toISOString(),
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
    batches_created: created.length + priorAssigned.length,
    entities_offered: created.reduce((s, c) => s + c.entityCount, 0) + priorAssigned.length,
    available_experts: available.length,
    pending_pool_size: pool.length,
    prior_completer_assigned: priorAssigned,
    skipped,
    created,
    errors,
    processed_at: new Date().toISOString(),
  });
}
