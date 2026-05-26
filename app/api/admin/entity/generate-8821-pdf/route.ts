/**
 * GET /api/admin/entity/generate-8821-pdf?entityId=<uuid>&expertId=<uuid>
 *
 * Generates a fully-filled IRS Form 8821 PDF with:
 *   Section 1 — taxpayer info (entity name, TIN, address) from request_entities
 *   Section 2 — designee info (CAF, PTIN, name, address, phone) from the
 *               chosen expert's profile
 *   Section 3 — standardized tax matters rows for the form_type + years
 *
 * Returns the PDF directly as application/pdf for the browser to download —
 * no Dropbox Sign, no email send, no database state change. Admin downloads,
 * emails to borrower manually, gets the signed copy back, uploads via the
 * existing "Upload 8821" admin button.
 *
 * Why this exists separate from the send-for-signature endpoint: that flow
 * fires generate8821PDF + Dropbox Sign API + DB writes + audit log + assignment
 * creation, totaling 30-60+ seconds and hitting Vercel's 502 timeout when
 * Dropbox Sign or any sub-call hangs. This endpoint does ONLY the PDF
 * generation (~2 seconds) and is the reliable fallback when the automated
 * flow misbehaves.
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { generate8821PDF, buildDesigneeFromProfile, validateExpertDesigneeCreds } from '@/lib/8821-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    return await handle(request);
  } catch (err: any) {
    console.error('[generate-8821-pdf] Unhandled exception:', err);
    return NextResponse.json(
      {
        error: 'Server error while generating 8821 PDF',
        detail: err?.message || String(err),
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

  const url = new URL(request.url);
  const entityId = url.searchParams.get('entityId')?.trim();
  const expertId = url.searchParams.get('expertId')?.trim();
  if (!entityId) return NextResponse.json({ error: 'entityId query param required' }, { status: 400 });
  if (!expertId) return NextResponse.json({ error: 'expertId query param required' }, { status: 400 });

  const admin = createAdminClient();

  // Load entity (Section 1 source)
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, tid, tid_kind, form_type, years, address, city, state, zip_code, signer_first_name, signer_last_name')
    .eq('id', entityId).single() as { data: any };
  if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  // Load expert (Section 2 source)
  const { data: expert } = await admin.from('profiles')
    .select('id, role, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
    .eq('id', expertId).single() as { data: any };
  if (!expert) return NextResponse.json({ error: 'Expert not found' }, { status: 404 });
  if (expert.role !== 'expert' && expert.role !== 'admin') {
    return NextResponse.json({ error: `User role=${expert.role}; only experts/admins can be 8821 designees` }, { status: 400 });
  }

  const missing = validateExpertDesigneeCreds(expert);
  if (missing.length > 0) {
    return NextResponse.json({
      error: `Expert ${expert.full_name || expert.id} is missing required Section 2 fields: ${missing.join(', ')}`,
      missing_fields: missing,
    }, { status: 422 });
  }

  // Build PDF
  const designee = buildDesigneeFromProfile(expert);
  const entityAddress = [entity.address, entity.city, entity.state, entity.zip_code]
    .filter(Boolean).join(', ') || '';
  const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generate8821PDF({
      taxpayer: {
        name: entity.entity_name || '',
        tin: entity.tid || '',
        address: entityAddress,
      },
      designee,
      formType,
      years: (entity.years || []).join(', '),
    } as any);
  } catch (err: any) {
    return NextResponse.json({
      error: 'PDF generation failed',
      detail: err?.message || String(err),
    }, { status: 500 });
  }

  // Audit log — non-blocking
  logAuditFromRequest(admin, request, {
    action: '8821_data_uploaded',  // closest existing audit category (no dedicated "downloaded" action yet)
    userId: user.id,
    userEmail: user.email || '',
    resourceType: 'request_entity',
    resourceId: entity.id,
    details: {
      kind: 'admin_pdf_download',
      entity_name: entity.entity_name,
      designee_expert_id: expert.id,
      designee_expert_name: expert.full_name,
      designee_caf: expert.caf_number,
      form_type: formType,
    },
  }).catch((e) => console.warn('[generate-8821-pdf] audit log failed:', e?.message));

  // Stream PDF back with download disposition
  const safeName = (entity.entity_name || 'entity').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
  const expertSafe = (expert.full_name || expert.id).split(/\s+/)[0].replace(/[^a-zA-Z0-9]+/g, '');
  const filename = `8821-${safeName}-designee-${expertSafe}.pdf`;

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
