/**
 * GET /api/invoicing/breakdown-pdf?invoiceId=<uuid>
 *
 * Manager/processor-facing: download the itemized breakdown PDF for one of
 * the caller's own invoices, generated on-demand from live completed entities
 * (flat per-entity rate, grouped by loan officer). This is the same artifact
 * we previously only emailed — now self-serve in the /invoicing portal so
 * clients (e.g. Centerstone) can pull "who ordered what" themselves.
 *
 * Side effect: re-stamps invoices.breakdown (JSONB) with the freshly computed
 * groups so the in-portal <InvoiceBreakdownTable> self-heals. This repairs the
 * historical rows that were stamped with 0 entities back when the PDF
 * generator infinite-looped (fixed 2026-06-01 in lib/invoice-breakdown-pdf).
 *
 * Auth: authenticated user whose profile.client_id owns the invoice (admins
 * and a valid CRON_SECRET bearer may pull any invoice — used for ops).
 *
 * Pricing: flat `clients.billing_rate_pdf` (default $59.98) per completed
 * entity. Monitoring/catch-up are intentionally omitted here — these clients
 * are billed a flat per-entity rate and the entity subtotal equals the
 * invoice total. (Matt 2026-06-01: "they only get billed $59.98 flat for each
 * completed entity.")
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { generateInvoiceBreakdownPdf } from '@/lib/invoice-breakdown-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isServiceCaller = !!process.env.CRON_SECRET && bearer === process.env.CRON_SECRET;

    let profile: { role: string | null; client_id: string | null } | null = null;
    if (isServiceCaller) {
      profile = { role: 'admin', client_id: null };
    } else {
      const cookieStore = await cookies();
      const sb = createServerRouteClient(cookieStore);
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      const { data } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
        data: { role: string | null; client_id: string | null } | null;
      };
      profile = data;
    }
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const invoiceId = new URL(request.url).searchParams.get('invoiceId')?.trim();
    if (!invoiceId) return NextResponse.json({ error: 'invoiceId query param required' }, { status: 400 });

    const admin = createAdminClient();
    const { data: invoice } = await admin.from('invoices')
      .select('id, client_id, invoice_number, total_amount, billing_period_start, mercury_pay_url')
      .eq('id', invoiceId).single() as { data: any };
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    if (!isAdmin && (!profile.client_id || profile.client_id !== invoice.client_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: client } = await admin.from('clients')
      .select('name, billing_rate_pdf').eq('id', invoice.client_id).single() as { data: any };

    const rate = Number(client?.billing_rate_pdf ?? 59.98);

    // Derive the billing month from the invoice number (INV-YYYY-MM-...) — more
    // reliable than billing_period_start, which some legacy rows baked with the
    // cron run date instead of the month bounds.
    const m = (invoice.invoice_number || '').match(/INV-(\d{4})-(\d{2})/);
    const year = m ? m[1] : (invoice.billing_period_start || '').slice(0, 4);
    const month = m ? m[2] : (invoice.billing_period_start || '').slice(5, 7);
    const periodStart = `${year}-${month}-01`;
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    const periodEnd = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

    // Step 1: client's requests → loan + processor lookup (no deep join).
    const { data: reqRows } = await admin.from('requests')
      .select('id, loan_number, requested_by')
      .eq('client_id', invoice.client_id)
      .limit(2000) as { data: any[] | null };
    const reqIds = (reqRows || []).map((r) => r.id);
    const loanMap: Record<string, string | null> = {};
    const reqByMap: Record<string, string> = {};
    for (const r of (reqRows || [])) { loanMap[r.id] = r.loan_number || null; reqByMap[r.id] = r.requested_by; }

    const userIds = [...new Set(Object.values(reqByMap))];
    const { data: profRows } = userIds.length
      ? await admin.from('profiles').select('id, full_name').in('id', userIds) as { data: any[] | null }
      : { data: [] };
    const procMap: Record<string, string> = {};
    for (const p of (profRows || [])) procMap[p.id] = p.full_name || 'Unattributed';

    // Step 2: completed entities in the period (batched in()).
    let rawEntities: any[] = [];
    for (let i = 0; i < reqIds.length; i += 200) {
      const { data: batch } = await admin.from('request_entities')
        .select('entity_name, form_type, completed_at, request_id')
        .in('request_id', reqIds.slice(i, i + 200))
        .eq('status', 'completed')
        .gte('completed_at', `${periodStart}T00:00:00Z`)
        .lte('completed_at', `${periodEnd}T23:59:59Z`)
        .order('completed_at', { ascending: true }) as { data: any[] | null };
      rawEntities = rawEntities.concat(batch || []);
    }

    // Group by loan officer, flat rate per entity.
    const groups: Record<string, { processor: string; entities: any[]; subtotal: number }> = {};
    for (const e of rawEntities) {
      const proc = procMap[reqByMap[e.request_id]] || 'Unattributed';
      if (!groups[proc]) groups[proc] = { processor: proc, entities: [], subtotal: 0 };
      groups[proc].entities.push({
        entity_name: e.entity_name,
        form_type: e.form_type || '-',
        completed_at: e.completed_at,
        loan_number: loanMap[e.request_id] || null,
        unit_price: rate,
        is_reorder: false,
      });
      groups[proc].subtotal = Math.round((groups[proc].subtotal + rate) * 100) / 100;
    }
    const processorGroups = Object.keys(groups).sort().map((k) => groups[k]);

    const pdfBuffer = await generateInvoiceBreakdownPdf({
      clientName: client?.name || 'Client',
      invoiceNumber: invoice.invoice_number,
      periodStart, periodEnd,
      grandTotal: Number(invoice.total_amount),
      payUrl: invoice.mercury_pay_url || '',
      isTest: false,
      processorGroups,
      monitoringDetails: [],
      catchupLine: null,
    });

    // Self-heal the in-portal breakdown table (fire-and-forget).
    (admin.from('invoices') as any).update({
      breakdown: { processor_groups: processorGroups, monitoring_details: [], catchup_line: null },
    }).eq('id', invoice.id).then(undefined, (e: any) =>
      console.warn('[invoicing/breakdown-pdf] breakdown stamp failed:', e?.message));

    const safe = (invoice.invoice_number || 'invoice').replace(/[^a-zA-Z0-9-]+/g, '_');
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="ModernTax-${safe}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('[invoicing/breakdown-pdf] error:', err);
    return NextResponse.json(
      { error: 'Failed to generate breakdown PDF', detail: err?.message || String(err) },
      { status: 500 },
    );
  }
}
