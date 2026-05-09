/**
 * POST /api/cash-flow/generate
 *
 * Generate the SBA Cash-Flow Analysis Pack for one entity (or all entities
 * on a request). Renders the PDF, uploads to Supabase storage, and creates a
 * billable line item ($49.99/loan) on the entity for the next monthly auto-
 * invoice run to pick up.
 *
 * Auth: processor / manager / admin in the same client as the entity, OR cron.
 *
 * Body:
 *   { entityId: string }   -- single entity
 *   { requestId: string }  -- every completed entity on the request (one PDF each)
 *
 * Returns:
 *   { generated: number, skipped: number, totalCharged: number, pdfs: [{entityId, url, ...}] }
 *
 * Idempotency: if entity.gross_receipts already has a `cash_flow_pack` entry
 * within 30 days, we re-serve the existing PDF URL and don't re-charge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { generateCashFlowPdf, aggregateCashFlowByYear } from '@/lib/cash-flow-pdf';
import { requireBearer } from '@/lib/auth-util';

// Pricing constant — matches the proposal: $49.99 per generated pack.
// Mirrored in components/UpgradeYourTeamPanel.tsx and CashFlowPackButton.tsx
// (Next.js route files can't export non-route symbols, so the constant is
// duplicated where needed rather than centralized).
const CASH_FLOW_PACK_PRICE = 49.99;

// Re-serve window — re-running within 30 days returns the existing PDF and
// doesn't double-bill. After 30 days, a new transcript pull may have refreshed
// the financials so a fresh pack is warranted.
const REUSE_WINDOW_DAYS = 30;

export async function POST(request: NextRequest) {
  try {
    // Auth — admin/processor/manager (own client only) OR cron secret
    const isCron = !requireBearer(request, process.env.CRON_SECRET);
    let userId: string | undefined;
    let userEmail: string | undefined;
    let userFullName: string = 'ModernTax';
    let userRole: string | undefined;
    let userClientId: string | null | undefined;

    if (!isCron) {
      const cookieStore = await cookies();
      const supabase = createServerRouteClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

      const adminTmp = createAdminClient();
      const { data: profile } = await adminTmp
        .from('profiles')
        .select('role, client_id, full_name')
        .eq('id', user.id)
        .single() as { data: { role: string; client_id: string | null; full_name: string | null } | null; error: any };

      const role = profile?.role;
      if (!profile || !['admin', 'processor', 'manager'].includes(role!)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
      userId = user.id;
      userEmail = user.email;
      userFullName = profile.full_name || user.email || 'Team Member';
      userRole = role;
      userClientId = profile.client_id;
      if (role !== 'admin' && !userClientId) {
        return NextResponse.json({ error: 'No client associated with your account.' }, { status: 403 });
      }
    }

    const admin = createAdminClient();
    const body = await request.json().catch(() => ({} as any));
    const entityId = typeof body?.entityId === 'string' ? body.entityId : null;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : null;

    if (!entityId && !requestId) {
      return NextResponse.json({ error: 'entityId or requestId required' }, { status: 400 });
    }

    // Resolve target entities — single id or all completed entities on a request.
    // Inner-join requests so we can scope by client_id for non-admins (no
    // cross-tenant leakage).
    const isClientScoped = !isCron && userRole !== 'admin';
    let q = admin
      .from('request_entities')
      .select(`
        id, entity_name, tid, form_type, status, gross_receipts,
        request_id,
        requests!inner(client_id, loan_number, clients(name))
      `);

    if (entityId) q = q.eq('id', entityId);
    if (requestId) q = q.eq('request_id', requestId).eq('status', 'completed');
    if (isClientScoped) q = q.eq('requests.client_id', userClientId!);

    const { data: entities } = (await q) as { data: any[] | null; error: any };

    if (!entities || entities.length === 0) {
      return NextResponse.json({ error: 'No matching entities found.' }, { status: 404 });
    }

    const generated: Array<{
      entityId: string;
      entityName: string;
      pdfUrl: string;
      reused: boolean;
      yearsCovered: number;
    }> = [];
    const skipped: Array<{ entityId: string; reason: string }> = [];
    let totalCharged = 0;

    for (const entity of entities) {
      try {
        // Re-serve window: don't re-bill within 30 days.
        const existingPack = entity.gross_receipts?.cash_flow_pack;
        if (existingPack?.generated_at) {
          const ageMs = Date.now() - new Date(existingPack.generated_at).getTime();
          if (ageMs < REUSE_WINDOW_DAYS * 86400000 && existingPack.pdf_url) {
            generated.push({
              entityId: entity.id,
              entityName: entity.entity_name,
              pdfUrl: existingPack.pdf_url,
              reused: true,
              yearsCovered: existingPack.years_covered || 0,
            });
            continue;
          }
        }

        const yearRows = aggregateCashFlowByYear(entity.gross_receipts || null);
        if (yearRows.length === 0) {
          // No financials = no point billing. Skip silently with a reason.
          skipped.push({ entityId: entity.id, reason: 'no_financials_extracted' });
          continue;
        }

        const lenderName = entity.requests?.clients?.name || 'Lender';
        const loanNumber = entity.requests?.loan_number || null;

        const pdfBytes = await generateCashFlowPdf({
          entityName: entity.entity_name,
          tin: entity.tid || '',
          formType: entity.form_type || '',
          loanNumber,
          lenderName,
          grossReceipts: entity.gross_receipts || null,
          generatedAt: new Date(),
          generatedBy: userFullName,
        });

        // Upload to Supabase storage. Path scoped under cash-flow-packs/{entity}.
        const filePath = `cash-flow-packs/${entity.id}/${Date.now()}-cash-flow-pack.pdf`;
        const { error: uploadError } = await admin.storage
          .from('uploads')
          .upload(filePath, Buffer.from(pdfBytes), {
            contentType: 'application/pdf',
            upsert: false,
          });
        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        // Persist metadata into entity.gross_receipts.cash_flow_pack so the
        // re-serve window check works on subsequent calls AND the auto-invoice
        // cron picks up the line item on the next billing run. Storing the
        // line item directly on the entity keeps it idempotent (one charge per
        // generated pack, regardless of how many times the endpoint is hit).
        const pack = {
          generated_at: new Date().toISOString(),
          generated_by: userId || 'cron',
          generated_by_name: userFullName,
          pdf_url: filePath,
          price: CASH_FLOW_PACK_PRICE,
          years_covered: yearRows.length,
          year_range: yearRows.map(r => r.year).join(', '),
          billed: false,
        };

        await admin
          .from('request_entities')
          .update({
            gross_receipts: {
              ...(entity.gross_receipts || {}),
              cash_flow_pack: pack,
            },
          })
          .eq('id', entity.id);

        totalCharged += CASH_FLOW_PACK_PRICE;
        generated.push({
          entityId: entity.id,
          entityName: entity.entity_name,
          pdfUrl: filePath,
          reused: false,
          yearsCovered: yearRows.length,
        });

        // Audit
        await logAuditFromRequest(admin, request, {
          action: 'file_uploaded',
          userId: userId || 'cron',
          userEmail: userEmail || '',
          resourceType: 'request_entity',
          resourceId: entity.id,
          details: {
            action: 'cash_flow_pack_generated',
            entity_name: entity.entity_name,
            pdf_url: filePath,
            years_covered: yearRows.length,
            price: CASH_FLOW_PACK_PRICE,
          },
        });
      } catch (err) {
        console.error(`[cash-flow/generate] Failed for entity ${entity.id}:`, err);
        skipped.push({
          entityId: entity.id,
          reason: err instanceof Error ? err.message : 'unknown_error',
        });
      }
    }

    return NextResponse.json({
      success: true,
      generated: generated.length,
      skipped: skipped.length,
      totalCharged,
      pdfs: generated,
      skippedDetails: skipped,
    });
  } catch (error) {
    console.error('cash-flow/generate error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
