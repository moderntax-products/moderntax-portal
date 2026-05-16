/**
 * Supply-demand expert acceptance workflow — domain helpers.
 *
 * Lifecycle (also documented on supabase/migration-assignment-batches.sql):
 *
 *   created (by admin or auto-matcher)
 *     ↓                            30-min acceptance window
 *   pending_acceptance ─────────────────────────→ expired (auto via cron)
 *     ↓ expert accepts                                ↓
 *   accepted ────→ all entities completed ────→ completed
 *     ↓ expert declines                              ↑
 *   declined                                         │
 *     ↓ admin cancels                                │
 *   cancelled                                        │
 *                                                    │
 *   (all terminal except 'accepted' which advances on entity completion)
 *
 * The per-entity expert_assignments rows mirror the batch lifecycle:
 *   pending_acceptance → assigned (on accept) → in_progress → completed/failed
 *
 * On accept, every entity in the batch gets its 8821 regenerated with the
 * accepting expert's designee credentials (CAF/PTIN/phone/name). The
 * original borrower-signed PDF is preserved on signed_8821_url for audit;
 * the new designee-correct PDF lands at expert_regenerated_8821_url.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generate8821PDF, buildDesigneeFromProfile, validateExpertDesigneeCreds, type ExpertProfileForDesignee } from './8821-pdf';

export const BATCH_MIN_ENTITIES = 1;       // operationally we want 3-5, but allow 1+
export const BATCH_MAX_ENTITIES = 8;       // hard upper bound — cognitive overload risk
export const ACCEPTANCE_WINDOW_MS = 30 * 60 * 1000;    // 30 minutes
export const COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export type BatchStatus =
  | 'pending_acceptance'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'completed'
  | 'cancelled';

export interface AssignmentBatchRow {
  id: string;
  expert_id: string;
  status: BatchStatus;
  offered_at: string;
  acceptance_deadline: string;
  accepted_at: string | null;
  declined_at: string | null;
  expired_at: string | null;
  cancelled_at: string | null;
  completion_deadline: string | null;
  completed_at: string | null;
  offered_by: string | null;
  decline_reason: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export interface CreateBatchInput {
  expertId: string;
  entityIds: string[];
  offeredBy: string;   // admin user id
  notes?: string;
}

export interface CreateBatchResult {
  ok: boolean;
  batch?: AssignmentBatchRow;
  error?: string;
  details?: any;
}

/**
 * Create an assignment batch + the pending_acceptance assignment rows.
 *
 * Pre-flight checks (returns { ok:false } on any failure):
 *   1. Expert exists, has role='expert', and has complete designee creds
 *   2. Each entity exists and has a signed 8821 (or form_type='W2_INCOME')
 *   3. None of the entities have an active assignment already
 *   4. Batch size within [BATCH_MIN_ENTITIES, BATCH_MAX_ENTITIES]
 *   5. Expert has no other pending_acceptance/accepted batch
 *      (one batch at a time per expert; prevents queue overload)
 */
export async function createBatch(
  admin: SupabaseClient,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  // 1. Validate size
  if (input.entityIds.length < BATCH_MIN_ENTITIES || input.entityIds.length > BATCH_MAX_ENTITIES) {
    return { ok: false, error: `Batch must contain ${BATCH_MIN_ENTITIES}-${BATCH_MAX_ENTITIES} entities` };
  }

  // 2. Validate expert
  const { data: expertProfile } = await admin
    .from('profiles')
    .select('id, role, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('id', input.expertId)
    .single() as { data: any };
  if (!expertProfile || expertProfile.role !== 'expert') {
    return { ok: false, error: 'Invalid expert' };
  }
  const missing = validateExpertDesigneeCreds(expertProfile);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Expert profile missing required designee fields: ${missing.join(', ')}`,
      details: { missing_fields: missing, expert_email: expertProfile.email },
    };
  }

  // 3. Validate entities
  const { data: entities } = await admin
    .from('request_entities')
    .select('id, entity_name, signed_8821_url, form_type, status')
    .in('id', input.entityIds) as { data: any[] | null };
  if (!entities || entities.length !== input.entityIds.length) {
    return { ok: false, error: 'One or more entities not found' };
  }
  const missing8821 = entities.filter(e => !e.signed_8821_url && e.form_type !== 'W2_INCOME');
  if (missing8821.length > 0) {
    return {
      ok: false,
      error: `Entities missing signed 8821: ${missing8821.map(e => e.entity_name).join(', ')}`,
    };
  }

  // 4. Reject if any entity already has an active assignment
  const { data: existingAssn } = await admin
    .from('expert_assignments')
    .select('id, entity_id, status')
    .in('entity_id', input.entityIds)
    .in('status', ['pending_acceptance', 'assigned', 'in_progress']) as { data: any[] | null };
  if (existingAssn && existingAssn.length > 0) {
    return {
      ok: false,
      error: `${existingAssn.length} of these entities already have an active assignment — cancel those first`,
      details: { conflicting_assignment_ids: existingAssn.map(a => a.id) },
    };
  }

  // 5. Reject if expert has another pending/accepted batch
  const { data: priorBatch } = await admin
    .from('assignment_batches')
    .select('id, status')
    .eq('expert_id', input.expertId)
    .in('status', ['pending_acceptance', 'accepted'])
    .limit(1)
    .maybeSingle() as { data: any };
  if (priorBatch) {
    return {
      ok: false,
      error: `Expert ${expertProfile.email} already has an active batch (status=${priorBatch.status}) — wait for it to complete or cancel it first`,
      details: { existing_batch_id: priorBatch.id },
    };
  }

  // ─── All checks passed — create batch + assignments ───────────────────────
  const now = new Date();
  const acceptanceDeadline = new Date(now.getTime() + ACCEPTANCE_WINDOW_MS).toISOString();

  const { data: batch, error: batchErr } = await admin
    .from('assignment_batches')
    .insert({
      expert_id: input.expertId,
      status: 'pending_acceptance',
      offered_at: now.toISOString(),
      acceptance_deadline: acceptanceDeadline,
      offered_by: input.offeredBy,
      notes: input.notes || null,
    })
    .select('*')
    .single() as { data: any; error: any };
  if (batchErr || !batch) {
    return { ok: false, error: 'Failed to create batch', details: batchErr?.message };
  }

  // Create pending_acceptance assignment rows for each entity
  const assignmentRows = input.entityIds.map(entityId => ({
    entity_id: entityId,
    expert_id: input.expertId,
    assigned_by: input.offeredBy,
    batch_id: batch.id,
    status: 'pending_acceptance',
  }));
  const { error: insErr } = await admin
    .from('expert_assignments')
    .insert(assignmentRows);
  if (insErr) {
    // Rollback the batch
    await admin.from('assignment_batches').delete().eq('id', batch.id);
    return { ok: false, error: 'Failed to create assignments', details: insErr.message };
  }

  return { ok: true, batch };
}

// ---------------------------------------------------------------------------
// ACCEPT
// ---------------------------------------------------------------------------

export interface AcceptBatchResult {
  ok: boolean;
  batch?: AssignmentBatchRow;
  regenerated?: { entityId: string; storagePath: string }[];
  errors?: { entityId: string; error: string }[];
  error?: string;
}

/**
 * Expert accepts a pending batch. For each entity in the batch:
 *   1. Pull the assigned expert's profile creds
 *   2. Build a designee from the profile
 *   3. Generate a fresh 8821 PDF with that designee
 *   4. Upload to storage at 8821/{entity_id}/{ts}-expert-regenerated-8821.pdf
 *   5. Save the path to expert_regenerated_8821_url
 * Then advance the batch + assignments to 'accepted' / 'assigned'.
 *
 * If any single entity's PDF regen fails, the batch still accepts — the
 * failures are returned in `errors` so the admin can fix them manually
 * via the existing Regenerate8821Button. We don't roll back the whole
 * accept because partial success is better than forcing the expert to
 * re-accept.
 */
export async function acceptBatch(
  admin: SupabaseClient,
  batchId: string,
  expertId: string,
): Promise<AcceptBatchResult> {
  const { data: batch } = await admin
    .from('assignment_batches')
    .select('*')
    .eq('id', batchId)
    .single() as { data: AssignmentBatchRow | null };
  if (!batch) return { ok: false, error: 'Batch not found' };

  // Auth: only the batch's expert can accept
  if (batch.expert_id !== expertId) {
    return { ok: false, error: 'This batch is not offered to you' };
  }
  if (batch.status !== 'pending_acceptance') {
    return { ok: false, error: `Cannot accept a batch in status "${batch.status}"` };
  }
  if (new Date(batch.acceptance_deadline) < new Date()) {
    return { ok: false, error: 'Acceptance window expired — batch will be returned to the pool' };
  }

  // Load expert profile (creds for PDF designee)
  const { data: expertProfile } = await admin
    .from('profiles')
    .select('id, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('id', expertId)
    .single() as { data: ExpertProfileForDesignee | null };
  if (!expertProfile) return { ok: false, error: 'Expert profile not found' };
  const missing = validateExpertDesigneeCreds(expertProfile);
  if (missing.length > 0) {
    return { ok: false, error: `Your profile is missing required fields: ${missing.join(', ')}` };
  }

  // Load entities in this batch
  const { data: assignments } = await admin
    .from('expert_assignments')
    .select('id, entity_id, request_entities(id, entity_name, tid, address, city, state, zip_code, form_type, years)')
    .eq('batch_id', batchId) as { data: any[] | null };

  // Regenerate 8821 for each entity (best-effort)
  const regenerated: { entityId: string; storagePath: string }[] = [];
  const errors: { entityId: string; error: string }[] = [];
  const designee = buildDesigneeFromProfile(expertProfile);

  for (const a of assignments || []) {
    const e = a.request_entities;
    if (!e) continue;
    try {
      const fullAddress = [e.address, e.city, e.state, e.zip_code].filter(Boolean).join(', ');
      const pdfBuffer = await generate8821PDF({
        taxpayer: { name: e.entity_name, tin: e.tid, address: fullAddress || '' },
        designee,
        formType: (e.form_type || '1040') as '1040' | '1065' | '1120' | '1120S' | '941',
        years: Array.isArray(e.years) ? e.years.join(', ') : '2022-2026',
      });
      const storagePath = `8821/${e.id}/${Date.now()}-batch-${batchId.slice(0, 8)}-expert-${expertId.slice(0, 8)}-regen.pdf`;
      const { error: upErr } = await admin.storage.from('uploads').upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
      if (upErr) throw new Error(upErr.message);
      await admin
        .from('request_entities')
        .update({ expert_regenerated_8821_url: storagePath })
        .eq('id', e.id);
      regenerated.push({ entityId: e.id, storagePath });
    } catch (err) {
      errors.push({ entityId: e.id, error: err instanceof Error ? err.message : String(err) });
      console.error(`[batch ${batchId.slice(0, 8)}] regen failed for entity ${e.id}:`, err);
    }
  }

  // Advance batch + assignments
  const acceptedAt = new Date();
  const completionDeadline = new Date(acceptedAt.getTime() + COMPLETION_WINDOW_MS).toISOString();

  const { data: updatedBatch, error: batchUpdErr } = await admin
    .from('assignment_batches')
    .update({
      status: 'accepted',
      accepted_at: acceptedAt.toISOString(),
      completion_deadline: completionDeadline,
    })
    .eq('id', batchId)
    .select('*')
    .single() as { data: AssignmentBatchRow | null; error: any };
  if (batchUpdErr) {
    return { ok: false, error: 'Failed to mark batch accepted', errors };
  }

  await admin
    .from('expert_assignments')
    .update({
      status: 'assigned',
      expert_clock_started_at: acceptedAt.toISOString(),
    } as any)
    .eq('batch_id', batchId)
    .eq('status', 'pending_acceptance');

  // Move entities into irs_queue if they aren't already
  await admin
    .from('request_entities')
    .update({ status: 'irs_queue' })
    .in('id', (assignments || []).map(a => a.entity_id))
    .in('status', ['8821_signed']);

  return { ok: true, batch: updatedBatch || undefined, regenerated, errors };
}

// ---------------------------------------------------------------------------
// DECLINE / EXPIRE / CANCEL — same release-to-pool semantics
// ---------------------------------------------------------------------------

export type ReleaseReason = 'declined' | 'expired' | 'cancelled';

export async function releaseBatch(
  admin: SupabaseClient,
  batchId: string,
  reason: ReleaseReason,
  details?: { actorId?: string; declineReason?: string },
): Promise<{ ok: boolean; error?: string; entitiesReturned?: number }> {
  const now = new Date().toISOString();
  const statusToTimestampField: Record<ReleaseReason, string> = {
    declined: 'declined_at',
    expired: 'expired_at',
    cancelled: 'cancelled_at',
  };

  // Mark the batch
  const { data: batch, error: bErr } = await admin
    .from('assignment_batches')
    .update({
      status: reason,
      [statusToTimestampField[reason]]: now,
      decline_reason: details?.declineReason || null,
    } as any)
    .eq('id', batchId)
    .eq('status', 'pending_acceptance') // idempotent — only release if still pending
    .select('id, expert_id')
    .single() as { data: any; error: any };
  if (bErr || !batch) {
    return { ok: false, error: 'Batch not found or already released' };
  }

  // Release per-entity assignments — mark them with the matching status so
  // they're auditable but no longer "active" for the gate check that
  // prevents re-batching.
  const assignmentStatus = reason === 'cancelled' ? 'cancelled' : reason;
  const { data: releasedAssns } = await admin
    .from('expert_assignments')
    .update({ status: assignmentStatus } as any)
    .eq('batch_id', batchId)
    .eq('status', 'pending_acceptance')
    .select('id, entity_id') as { data: any[] | null };

  return { ok: true, entitiesReturned: (releasedAssns || []).length };
}

// ---------------------------------------------------------------------------
// EXPIRY SWEEP (cron)
// ---------------------------------------------------------------------------

export async function expireOverdueBatches(admin: SupabaseClient): Promise<{ expired: number }> {
  const { data: expired } = await admin
    .from('assignment_batches')
    .select('id')
    .eq('status', 'pending_acceptance')
    .lt('acceptance_deadline', new Date().toISOString()) as { data: any[] | null };
  let count = 0;
  for (const b of expired || []) {
    const r = await releaseBatch(admin, b.id, 'expired');
    if (r.ok) count += 1;
  }
  return { expired: count };
}
