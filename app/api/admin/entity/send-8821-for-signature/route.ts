/**
 * POST /api/admin/entity/send-8821-for-signature
 *
 * Admin manually fires an 8821-for-signature envelope to a borrower's
 * signer_email. Use case: API intake (Clearfirm, partner channels) arrives
 * without a signed 8821 — the original intake comment in
 * app/api/intake/transcript/route.ts says "Skip 8821 — ready for expert
 * assignment", which assumes upstream has handled signing. When that
 * assumption breaks (Affinitifi CF-affinitifi-321 example 2026-05-23),
 * the entity sits in failed/irs_queue with no path forward.
 *
 * This endpoint:
 *   1. Loads the entity + selected expert's profile
 *   2. Validates the expert has full Section 2 designee creds (CAF, PTIN,
 *      phone, address) — fails loud with which fields are missing
 *   3. Generates a fresh 8821 PDF with:
 *        Section 1 — entity name, TIN, address from request_entities row
 *        Section 2 — expert's CAF, PTIN, name, address, phone from profiles
 *   4. Fires Dropbox Sign envelope to signer_email (CC: matt@moderntax.io)
 *   5. Persists signature_id on the entity row + flips status to '8821_sent'
 *   6. Auto-assigns the entity to the chosen expert via expert_assignments
 *      (so when the borrower signs and the entity flips to 8821_signed,
 *      it's already routed)
 *
 * Body:
 *   { entityId: string, expertId: string, signerEmail: string,
 *     signerFirstName?: string, signerLastName?: string }
 *
 * Returns:
 *   { success, signatureRequestId, expertName, entityName }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { buildDesigneeFromProfile, validateExpertDesigneeCreds } from '@/lib/8821-pdf';
import { sendSignatureRequest } from '@/lib/dropbox-sign';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  // Top-level try/catch — guarantees we ALWAYS return JSON, even on
  // unhandled exceptions. Without this, Next.js renders an HTML error
  // page when something throws, which the client then tries to JSON.parse
  // (producing the famously cryptic "Unexpected token '<'" error).
  try {
    return await handle(request);
  } catch (err: any) {
    console.error('[send-8821] Unhandled exception:', err);
    return NextResponse.json(
      {
        error: 'Server error while generating + sending 8821',
        detail: err?.message || String(err),
        // stack only in non-prod to avoid leaking internals
        ...(process.env.NODE_ENV !== 'production' ? { stack: err?.stack } : {}),
      },
      { status: 500 },
    );
  }
}

async function handle(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: callerProfile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { entityId?: string; expertId?: string; signerEmail?: string; signerFirstName?: string; signerLastName?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const entityId = body.entityId?.trim();
  const expertId = body.expertId?.trim();
  const signerEmail = body.signerEmail?.trim().toLowerCase();
  if (!entityId)    return NextResponse.json({ error: 'entityId required' }, { status: 400 });
  if (!expertId)    return NextResponse.json({ error: 'expertId required' }, { status: 400 });
  if (!signerEmail || !EMAIL_RE.test(signerEmail)) {
    return NextResponse.json({ error: 'Valid signerEmail required — Dropbox Sign will deliver the envelope to this address' }, { status: 400 });
  }

  const admin = createAdminClient();

  // 1. Load entity + verify it doesn't already have a signed 8821
  const { data: entity, error: entErr } = await admin.from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code, signed_8821_url, status, signer_email, signer_first_name, signer_last_name, request_id')
    .eq('id', entityId).single() as { data: any; error: any };
  if (entErr || !entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  if (entity.signed_8821_url) {
    return NextResponse.json({ error: 'Entity already has a signed 8821 on file. Use Regenerate 8821 if you need a fresh designee.' }, { status: 409 });
  }

  // 2. Load expert profile + validate Section 2 fields
  const { data: expert, error: expErr } = await admin.from('profiles')
    .select('id, role, full_name, email, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('id', expertId).single() as { data: any; error: any };
  if (expErr || !expert) return NextResponse.json({ error: 'Expert not found' }, { status: 404 });
  if (expert.role !== 'expert' && expert.role !== 'admin') {
    return NextResponse.json({ error: `Selected user is role=${expert.role}; only experts can be 8821 designees` }, { status: 400 });
  }

  const missing = validateExpertDesigneeCreds(expert);
  if (missing.length > 0) {
    return NextResponse.json({
      error: `Expert ${expert.full_name || expert.email} is missing required Section 2 fields: ${missing.join(', ')}`,
      missing_fields: missing,
      admin_hint: `Have the expert complete their profile at /expert/profile, or set the missing fields directly via /admin/experts.`,
    }, { status: 422 });
  }

  // 3. Build designee + send the envelope. The dropbox-sign helper
  // generates the PDF internally using the entity's taxpayer info and
  // the expert's designee info we pass in.
  const expertDesignee = buildDesigneeFromProfile(expert);
  const signerFirstName = body.signerFirstName?.trim() || entity.signer_first_name || null;
  const signerLastName  = body.signerLastName?.trim()  || entity.signer_last_name  || null;

  let signatureRequestId: string;
  try {
    const sigResult = await sendSignatureRequest({
      id: entity.id,
      entity_name: entity.entity_name,
      form_type: entity.form_type || '1040',
      tid: entity.tid,
      tid_kind: entity.tid_kind,
      signer_first_name: signerFirstName,
      signer_last_name: signerLastName,
      address: entity.address || undefined,
      city: entity.city || undefined,
      state: entity.state || undefined,
      zip_code: entity.zip_code || undefined,
      expertDesignee,
    }, signerEmail);
    signatureRequestId = sigResult.signatureRequestId;
  } catch (err: any) {
    console.error('[send-8821] Dropbox Sign failed:', err);
    return NextResponse.json({
      error: 'Failed to send signature request',
      detail: err?.message || String(err),
    }, { status: 502 });
  }

  // 4. Persist signature_id + signer email + flip status to 8821_sent
  // Race-safe: only update if signed_8821_url is still null (someone could
  // have uploaded a signed one between our read and write).
  await (admin.from('request_entities') as any).update({
    signature_id: signatureRequestId,
    signer_email: signerEmail,
    signer_first_name: signerFirstName,
    signer_last_name: signerLastName,
    status: '8821_sent',
  }).eq('id', entity.id).is('signed_8821_url', null);

  // 5. Auto-assign to the selected expert so when the borrower signs,
  // the entity is already routed. Skip if there's already an active
  // assignment (don't clobber a manual reassignment).
  const { data: existingActive } = await admin.from('expert_assignments')
    .select('id').eq('entity_id', entity.id)
    .in('status', ['assigned', 'in_progress']).limit(1) as { data: any[] };
  if (!existingActive || existingActive.length === 0) {
    await (admin.from('expert_assignments') as any).insert({
      entity_id: entity.id,
      expert_id: expert.id,
      status: 'assigned',
      assigned_at: new Date().toISOString(),
      // 24-hour SLA from sign time will be computed when 8821 lands; for
      // now, leave sla_deadline null until 8821 status flips.
    });
  }

  // 6. Audit log
  await logAuditFromRequest(admin, request, {
    action: '8821_sent_for_signature_by_admin',
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request_entity',
    resourceId: entity.id,
    details: {
      entity_name: entity.entity_name,
      expert_id: expert.id,
      expert_name: expert.full_name,
      designee_caf: expert.caf_number,
      signer_email: signerEmail,
      signature_request_id: signatureRequestId,
    },
  });

  console.log(`[send-8821] ${entity.entity_name} → ${signerEmail} (designee: ${expert.full_name} / CAF ${expert.caf_number}) | sig=${signatureRequestId}`);

  return NextResponse.json({
    success: true,
    signatureRequestId,
    expertName: expert.full_name,
    expertCaf: expert.caf_number,
    entityName: entity.entity_name,
    signerEmail,
  });
}
