/**
 * POST /api/admin/reorder-from-history
 *
 * Clone a prior entity into a new request for the same processor, reusing
 * the existing signed 8821 when it's still within the validity window.
 * Lets admin satisfy a "re-pull 2024 for Peter Geyen" email without making
 * the processor re-upload a CSV + new 8821.
 *
 * Driver: 2026-05-28 Matt — Soobin's "re-pull 2024 tax transcripts for
 * Peter Geyen" email. The 8821 is already on file. Admin should be able
 * to reorder in one click from /admin/email-intake.
 *
 * Body:
 *   {
 *     processor_id:       UUID,                // requester for the new request
 *     source_entity_id:   UUID,                // entity row to clone from
 *     new_years:          (string | number)[], // years for the new pull
 *     loan_number:        string,              // free-text — usually the same loan or "REORDER-<orig>"
 *     notes?:             string,              // surfaces on the request row
 *     reuse_8821?:        boolean,             // default true; admin can force a fresh 8821 if needed
 *   }
 *
 * Behavior:
 *   1. Validate the source entity actually belongs to a request submitted
 *      by the named processor (admin can't accidentally cross client lines).
 *   2. Create a new request row under the same client_id, requested_by =
 *      processor_id, status='submitted'.
 *   3. Create a new request_entities row cloning name / tid / form_type /
 *      signer fields / address.
 *   4. If reuse_8821 and the source entity has a signed_8821_url within
 *      SIGNED_8821_VALID_DAYS → copy signed_8821_url + signature_created_at,
 *      set entity.status='8821_signed' (ready for the IRS-queue pipeline).
 *   5. Otherwise → status='pending', so the normal 8821 flow can pick it up.
 *   6. Auto-post the standard intake note via autoPostIntakeNote so the
 *      expert sees Sonja / Soobin's instructions on the new entity.
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { autoPostIntakeNote } from '@/lib/intake-note-autopost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Keep in sync with /api/admin/processor-entity-history. */
const SIGNED_8821_VALID_DAYS = 120;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: adminProfile } = await sb.from('profiles')
    .select('role, full_name, email').eq('id', user.id).single() as { data: { role: string; full_name: string | null; email: string } | null };
  if (adminProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: {
    processor_id?: string;
    source_entity_id?: string;
    new_years?: (string | number)[];
    loan_number?: string;
    notes?: string;
    reuse_8821?: boolean;
  };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const processorId = body.processor_id?.trim();
  const sourceEntityId = body.source_entity_id?.trim();
  const loanNumber = body.loan_number?.trim();
  const notes = body.notes?.trim() || null;
  const reuse8821 = body.reuse_8821 !== false; // default true
  const newYears = (body.new_years || [])
    .map((y) => parseInt(String(y), 10))
    .filter(Number.isFinite);

  if (!processorId) return NextResponse.json({ error: 'processor_id required' }, { status: 400 });
  if (!sourceEntityId) return NextResponse.json({ error: 'source_entity_id required' }, { status: 400 });
  if (!loanNumber) return NextResponse.json({ error: 'loan_number required' }, { status: 400 });
  if (newYears.length === 0) return NextResponse.json({ error: 'new_years required (e.g. [2024])' }, { status: 400 });

  const admin = createAdminClient();

  // 1. Look up the processor + source entity. We require the source
  //    entity's request to have been submitted BY this processor —
  //    prevents cross-client reorders via guessed UUIDs.
  const { data: processorProfile } = await admin.from('profiles')
    .select('id, full_name, email, role, client_id')
    .eq('id', processorId).single() as { data: any };
  if (!processorProfile) return NextResponse.json({ error: 'Processor not found' }, { status: 404 });
  if (!['processor', 'manager'].includes(processorProfile.role)) {
    return NextResponse.json({ error: 'Target user is not a processor/manager' }, { status: 400 });
  }
  if (!processorProfile.client_id) {
    return NextResponse.json({ error: 'Processor has no client_id — cannot reorder' }, { status: 400 });
  }

  const { data: sourceEntity } = await admin.from('request_entities')
    .select(`
      id, entity_name, tid, tid_kind, form_type, signer_first_name, signer_last_name,
      signer_email, address, city, state, zip_code,
      signed_8821_url, signature_created_at,
      requests!inner(id, client_id, requested_by, loan_number)
    `)
    .eq('id', sourceEntityId).single() as { data: any };
  if (!sourceEntity) return NextResponse.json({ error: 'Source entity not found' }, { status: 404 });
  if (sourceEntity.requests?.requested_by !== processorId) {
    return NextResponse.json({
      error: 'Source entity does not belong to a request submitted by this processor.',
    }, { status: 403 });
  }
  if (sourceEntity.requests?.client_id !== processorProfile.client_id) {
    return NextResponse.json({
      error: 'Source entity is on a different client than this processor.',
    }, { status: 403 });
  }

  // 2. Decide whether the existing 8821 is reusable.
  let canReuse8821 = false;
  let sigAgeDays: number | null = null;
  if (reuse8821 && sourceEntity.signed_8821_url) {
    if (sourceEntity.signature_created_at) {
      const ms = Date.now() - Date.parse(sourceEntity.signature_created_at);
      if (Number.isFinite(ms)) {
        sigAgeDays = Math.floor(ms / (24 * 3600 * 1000));
        canReuse8821 = sigAgeDays <= SIGNED_8821_VALID_DAYS;
      }
    } else {
      // No signature timestamp — be conservative, don't reuse.
      canReuse8821 = false;
    }
  }

  // 3. Create the new parent request row. We populate source_request_id
  //    so /admin/requests/[id] can render a "Reorder of loan #..." badge
  //    and ops can trace the chain for billing audits without grepping
  //    notes. Two-phase insert handles older envs where the column hasn't
  //    been migrated yet — same fallback pattern as Admin8821Upload.
  const requestRow: Record<string, unknown> = {
    client_id: processorProfile.client_id,
    requested_by: processorId,
    loan_number: loanNumber,
    intake_method: 'admin_reorder',
    status: 'submitted',
    source_request_id: sourceEntity.requests.id,
    notes: notes
      ? `Reorder from history (source entity ${sourceEntity.id.slice(0, 8)}, source loan ${sourceEntity.requests.loan_number || '-'}). ${notes}`
      : `Reorder from history (source entity ${sourceEntity.id.slice(0, 8)}, source loan ${sourceEntity.requests.loan_number || '-'}).`,
  };
  let { data: newRequest, error: reqErr } = await (admin.from('requests') as any)
    .insert(requestRow).select('id').single() as { data: { id: string } | null; error: any };
  if (reqErr && /source_request_id|column .* does not exist|PGRST204/i.test(reqErr.message || '')) {
    console.warn('[reorder-from-history] source_request_id column missing — falling back without lineage. Paste supabase/migration-request-source-lineage.sql in Studio to enable.');
    delete (requestRow as any).source_request_id;
    ({ data: newRequest, error: reqErr } = await (admin.from('requests') as any)
      .insert(requestRow).select('id').single() as { data: { id: string } | null; error: any });
  }

  if (reqErr || !newRequest) {
    console.error('[reorder-from-history] failed to create request:', reqErr);
    return NextResponse.json({ error: reqErr?.message || 'Failed to create request' }, { status: 500 });
  }

  // 4. Clone the entity row.
  const newEntityRow: Record<string, unknown> = {
    request_id: newRequest.id,
    entity_name: sourceEntity.entity_name,
    tid: sourceEntity.tid,
    tid_kind: sourceEntity.tid_kind,
    form_type: sourceEntity.form_type,
    years: newYears,
    signer_first_name: sourceEntity.signer_first_name,
    signer_last_name: sourceEntity.signer_last_name,
    signer_email: sourceEntity.signer_email,
    address: sourceEntity.address,
    city: sourceEntity.city,
    state: sourceEntity.state,
    zip_code: sourceEntity.zip_code,
    status: canReuse8821 ? '8821_signed' : 'pending',
  };
  if (canReuse8821) {
    newEntityRow.signed_8821_url = sourceEntity.signed_8821_url;
    newEntityRow.signature_created_at = sourceEntity.signature_created_at;
  }

  const { data: insertedEntity, error: entErr } = await (admin.from('request_entities') as any)
    .insert(newEntityRow).select('id').single() as { data: { id: string } | null; error: any };

  if (entErr || !insertedEntity) {
    console.error('[reorder-from-history] failed to insert entity:', entErr);
    // Best-effort: roll the request back so we don't leave an orphan.
    await admin.from('requests').delete().eq('id', newRequest.id);
    return NextResponse.json({ error: entErr?.message || 'Failed to clone entity' }, { status: 500 });
  }

  // 5. Auto-post the intake instruction note so the expert sees the
  //    reorder context + the client's standard template. Fire-and-forget.
  try {
    await autoPostIntakeNote(admin, {
      entityId: insertedEntity.id,
      entityName: sourceEntity.entity_name,
      formType: sourceEntity.form_type,
      years: newYears,
      requesterUserId: processorId,
      requesterName: processorProfile.full_name || processorProfile.email || 'Processor',
      requesterRole: processorProfile.role as 'processor' | 'manager',
      clientId: processorProfile.client_id,
      freeTextNotes: notes
        ? `Reorder requested by admin (${adminProfile.full_name || adminProfile.email}). ${notes}`
        : `Reorder requested by admin (${adminProfile.full_name || adminProfile.email}). Source entity: ${sourceEntity.id.slice(0, 8)} on loan ${sourceEntity.requests.loan_number || '-'}.`,
    });
  } catch (noteErr) {
    console.warn('[reorder-from-history] intake-note autopost failed:', noteErr);
  }

  return NextResponse.json({
    success: true,
    request_id: newRequest.id,
    entity_id: insertedEntity.id,
    entity_name: sourceEntity.entity_name,
    loan_number: loanNumber,
    new_years: newYears,
    reused_8821: canReuse8821,
    signature_age_days: sigAgeDays,
    signed_8821_valid_window_days: SIGNED_8821_VALID_DAYS,
    next_step: canReuse8821
      ? 'Entity is ready for IRS queue — no 8821 work needed.'
      : 'Entity is pending — needs a fresh 8821 (existing one missing or too old).',
  });
}
