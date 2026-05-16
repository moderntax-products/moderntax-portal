/**
 * Regenerate an 8821 PDF with the currently-assigned expert's IRS designee
 * credentials. Admin-only.
 *
 * Why this exists: when an entity is reassigned to a different expert
 * AFTER the 8821 was generated and signed under the prior designee, the
 * signed PDF on file still lists the wrong designee. The IRS won't honor
 * a PPS call from someone whose CAF/PTIN doesn't match the appointee on
 * the 8821. This endpoint produces a fresh PDF with the new expert as
 * the designee. The borrower-signed PDF is preserved (untouched) for
 * audit; the regenerated unsigned PDF is stored as
 * `expert_regenerated_8821_url` and surfaced in /api/expert/download-8821
 * as the preferred file for outbound IRS calls.
 *
 * Phase 1 (this endpoint): produces an UNSIGNED PDF with the right designee.
 * The expert must either:
 *   (a) re-collect a borrower signature (proper flow), or
 *   (b) overlay the borrower's existing signature image via a follow-up
 *       endpoint (PDF-stamping work, MOD-227 backlog).
 *
 * POST /api/admin/expert/regenerate-8821
 *   Body: { entityId: string }
 *   Response: { success, expert_id, designee_caf, storage_path }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import {
  generate8821PDF,
  buildDesigneeFromProfile,
  validateExpertDesigneeCreds,
} from '@/lib/8821-pdf';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: callerProfile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (callerProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { entityId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.entityId) {
    return NextResponse.json({ error: 'entityId required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // Load entity + assigned expert + taxpayer info needed for the PDF
  const { data: entity } = await admin
    .from('request_entities')
    .select('id, entity_name, tid, address, city, state, zip_code, form_type, years, signer_email')
    .eq('id', body.entityId)
    .single() as { data: any };
  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // Active assignment
  const { data: activeAssn } = await admin
    .from('expert_assignments')
    .select('id, expert_id, profiles!expert_assignments_expert_id_fkey(id, email, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code)')
    .eq('entity_id', body.entityId)
    .in('status', ['assigned', 'in_progress'])
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: any };

  if (!activeAssn) {
    return NextResponse.json({ error: 'No active expert assignment on this entity' }, { status: 400 });
  }

  const expertProfile = activeAssn.profiles;
  const missing = validateExpertDesigneeCreds(expertProfile);
  if (missing.length > 0) {
    return NextResponse.json({
      error: `Assigned expert ${expertProfile.full_name || expertProfile.email} is missing required designee fields: ${missing.join(', ')}. They must complete /expert/profile first.`,
      missing_fields: missing,
    }, { status: 400 });
  }

  // Build the new designee + generate the PDF
  let pdfBuffer: Buffer;
  let designeeCaf: string;
  try {
    const designee = buildDesigneeFromProfile(expertProfile);
    designeeCaf = designee.caf;
    const fullAddress = [entity.address, entity.city, entity.state, entity.zip_code].filter(Boolean).join(', ');
    pdfBuffer = await generate8821PDF({
      taxpayer: {
        name: entity.entity_name,
        tin: entity.tid,
        address: fullAddress || '',
      },
      designee,
      formType: (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S' | '941',
      years: Array.isArray(entity.years) ? entity.years.join(', ') : '2022-2026',
    });
  } catch (err) {
    console.error('[regenerate-8821] PDF generation failed:', err);
    return NextResponse.json({
      error: 'Failed to generate PDF',
      admin_hint: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }

  // Upload to storage. Use a versioned path so we don't overwrite the
  // borrower-signed file (which lives under signed_8821_url).
  const timestamp = Date.now();
  const storagePath = `8821/${entity.id}/${timestamp}-expert-regenerated-8821.pdf`;
  const { error: upErr } = await admin.storage.from('uploads').upload(storagePath, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (upErr) {
    console.error('[regenerate-8821] storage upload failed:', upErr);
    return NextResponse.json({ error: 'Failed to save PDF', admin_hint: upErr.message }, { status: 500 });
  }

  // Record on the entity (best-effort — column may not exist in older envs;
  // we still return success because the PDF is in storage either way).
  const { error: colErr } = await admin
    .from('request_entities')
    .update({ expert_regenerated_8821_url: storagePath } as any)
    .eq('id', body.entityId);
  if (colErr && !/column .* does not exist|PGRST204/i.test(colErr.message || '')) {
    console.warn('[regenerate-8821] expert_regenerated_8821_url column update failed:', colErr.message);
  }

  await logAuditFromRequest(admin, request, {
    action: '8821_regenerated' as any,
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request_entity',
    resourceId: entity.id,
    details: {
      assigned_expert_id: expertProfile.id,
      assigned_expert_email: expertProfile.email,
      designee_caf_last4: designeeCaf.slice(-4),
      storage_path: storagePath,
    },
  });

  return NextResponse.json({
    success: true,
    entity_id: entity.id,
    expert_id: expertProfile.id,
    expert_name: expertProfile.full_name,
    storage_path: storagePath,
    note: 'Regenerated PDF is unsigned — borrower signature still required. The original borrower-signed PDF is unchanged at signed_8821_url.',
  });
}
