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
  // street on line 1, "City, ST ZIP" on line 2 (newline-separated) so the
  // 8821 taxpayer box renders the full address without dropping City/ST/ZIP.
  const cityStateZip = [
    [entity.city, entity.state].filter(Boolean).join(', '),
    entity.zip_code,
  ].filter(Boolean).join(' ').trim();
  const entityAddress = [entity.address, cityStateZip].filter(Boolean).join('\n');
  const formType = (entity.form_type || '1040') as '1040' | '1065' | '1120' | '1120S';

  // Years format: prefer compact contiguous range ("2022-2024") for
  // contiguous year lists since it ALWAYS fits the 128pt single-line
  // cell in Section 3 column C. Fall back to comma-separated list for
  // non-contiguous years. NEVER use the prior multi-line format —
  // pdf-lib truncates anything past the first line in single-line
  // fields and IRS rejects forms with cut-off year ranges (Joel
  // 2026-05-26 — j&j mechanical 8821 showed "2022-20").
  const entityYears: number[] = (entity.years || []).map((y: any) => parseInt(String(y), 10)).filter(Number.isFinite);
  const yearsString = formatYearsForSection3(entityYears);

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
      years: yearsString,
    });
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

/**
 * Format a year list for the IRS Form 8821 Section 3 column C cell.
 * The cell is 128pt wide × 12pt tall — a single-line text field that
 * truncates anything past ~21 chars at standard font size.
 *
 * Strategy:
 *   - Empty / unknown → default "2022-2026" (longest safe historical range)
 *   - Single year → "2024"
 *   - Contiguous range (≥2 years, no gaps) → "2022-2024" (always fits)
 *   - Non-contiguous → "2020, 2022, 2024" comma list (fits up to ~4 years)
 *   - Non-contiguous with >4 years → fall back to min-max range ("2020-2025")
 *     even though it implies years we didn't ask for, because it's better
 *     than truncating and getting the form rejected
 */
function formatYearsForSection3(years: number[]): string {
  if (!years || years.length === 0) return '2022-2026';
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const isContiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  if (isContiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  // Non-contiguous: try comma list if it fits the cell
  const listForm = sorted.join(', ');
  if (listForm.length <= 21) return listForm;
  // Too long — fall back to min-max range (over-claims a few years but
  // beats a truncated cell that the IRS rejects)
  return `${sorted[0]}-${sorted[sorted.length - 1]}`;
}
