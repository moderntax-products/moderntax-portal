/**
 * POST /api/admin/generate-consolidation-report
 *
 * Admin-only generator for the Loan-Package Consolidation Report SKU.
 * Pulls the request + all entities, renders the PDF via
 * lib/loan-consolidation-report.ts, uploads it to storage, and returns
 * a signed download URL.
 *
 * Two modes:
 *   - mode='demo'  → free generation (no SKU stamp, no billing). For
 *                    Matt to use during demos with real customer data
 *                    without triggering a $99 charge.
 *   - mode='paid'  → stamps requests.add_ons.loan_consolidation_report
 *                    with the document URL so the auto-invoice cron
 *                    bills $99 at month-end. Use when the customer
 *                    actually opted in at intake.
 *
 * Auth: admin only.
 *
 * Body:
 *   {
 *     request_id: UUID,
 *     mode?: 'demo' | 'paid'   // default 'demo' (safer)
 *   }
 *
 * Driver: 2026-05-28 Matt — the SKU was sold without a deliverable.
 * Ship the generator + demo path so customer demos work today, and
 * leave the 'paid' switch flippable for whenever you want to enable
 * the full billed flow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { generateConsolidationReportPdf, type ConsolidationEntity } from '@/lib/loan-consolidation-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sb = createServerRouteClient(cookieStore);
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { request_id?: string; mode?: 'demo' | 'paid' };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const requestId = body.request_id?.trim();
  if (!requestId) return NextResponse.json({ error: 'request_id required' }, { status: 400 });
  const mode = body.mode === 'paid' ? 'paid' : 'demo';

  const admin = createAdminClient();

  // Pull the request + its entities + client + processor for the cover.
  const { data: req, error: reqErr } = await admin.from('requests')
    .select(`
      id, loan_number, created_at, add_ons,
      clients(name),
      profiles!requests_requested_by_fkey(full_name, email),
      request_entities(
        id, entity_name, tid, tid_kind, form_type, years, status, completed_at,
        signer_first_name, signer_last_name, gross_receipts, transcript_urls
      )
    `)
    .eq('id', requestId).single() as { data: any; error: any };
  if (reqErr || !req) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }

  const entities: ConsolidationEntity[] = (req.request_entities || []).map((e: any) => ({
    id: e.id,
    entity_name: e.entity_name,
    tid: e.tid,
    tid_kind: e.tid_kind,
    form_type: e.form_type,
    years: e.years,
    status: e.status,
    completed_at: e.completed_at,
    signer_first_name: e.signer_first_name,
    signer_last_name: e.signer_last_name,
    gross_receipts: e.gross_receipts,
    transcript_urls: e.transcript_urls,
  }));

  if (entities.length === 0) {
    return NextResponse.json({ error: 'No entities on this request — nothing to consolidate.' }, { status: 400 });
  }

  // Generate the PDF.
  const pdfBuffer = await generateConsolidationReportPdf({
    requestId: req.id,
    loanNumber: req.loan_number,
    clientName: req.clients?.name || 'Unknown client',
    processorName: req.profiles?.full_name || req.profiles?.email || 'Processor',
    generatedAt: new Date().toISOString(),
    entities,
  });

  // Upload to storage.
  const storagePath = `consolidation-reports/${req.id}/${Date.now()}-loan-consolidation-${mode}.pdf`;
  const { error: uploadErr } = await admin.storage
    .from('uploads')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
  if (uploadErr) {
    console.error('[generate-consolidation-report] upload failed:', uploadErr);
    return NextResponse.json({ error: 'Upload failed: ' + uploadErr.message }, { status: 500 });
  }

  // Signed URL valid for 1 hour.
  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(storagePath, 3600);

  // 'paid' mode: stamp add_ons so the cron bills $99 at month-end.
  // 'demo' mode: do NOT stamp — purely free generation for demo / preview.
  let billing = 'demo (no charge)';
  if (mode === 'paid') {
    const addOns = { ...(req.add_ons || {}) };
    addOns.loan_consolidation_report = {
      ...(addOns.loan_consolidation_report || {}),
      selected: true,
      price: 99.00,
      sku: 'loan-consolidation-report',
      selected_at: addOns.loan_consolidation_report?.selected_at || new Date().toISOString(),
      generated_at: new Date().toISOString(),
      storage_path: storagePath,
    };
    const { error: stampErr } = await (admin.from('requests') as any)
      .update({ add_ons: addOns })
      .eq('id', req.id);
    if (stampErr && /add_ons|column .* does not exist/i.test(stampErr.message || '')) {
      return NextResponse.json({
        warning: 'PDF generated and uploaded, but add_ons column missing — billing stamp skipped. Paste supabase/migration-request-add-ons.sql.',
        signed_url: signed?.signedUrl,
        storage_path: storagePath,
        billing: 'demo (column missing)',
      });
    }
    billing = 'will bill $99 at month-end';
  }

  return NextResponse.json({
    success: true,
    request_id: req.id,
    loan_number: req.loan_number,
    entity_count: entities.length,
    mode,
    billing,
    storage_path: storagePath,
    signed_url: signed?.signedUrl,
    expires_in_seconds: 3600,
  });
}
