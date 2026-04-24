/**
 * Mercury ↔ ModernTax invoice reconciliation.
 *
 * GET /api/admin/mercury-reconcile
 *   Guarded by CRON_SECRET. Pulls every invoice + customer from Mercury,
 *   matches them to our `clients` table by email (billing_ap_email) or name,
 *   and upserts a corresponding row into `invoices` if it doesn't already
 *   exist. Idempotent — safe to rerun. Returns a JSON report of what was
 *   linked, created, or skipped.
 *
 * Why this endpoint exists:
 *   • Mercury is authoritative for invoice status (paid/unpaid). Pulling
 *     history lets our portal, daily summary email, and Q2 revenue dashboard
 *     reflect real cash collection, not just what we've auto-sent.
 *   • Runs from Vercel (stable IP) when the local IP isn't whitelisted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import {
  listMercuryCustomers,
  listMercuryInvoices,
  getMercuryPayUrl,
  getMercuryInvoicePdfUrl,
} from '@/lib/mercury';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ReconcileReport = {
  clientMatches: {
    mercuryCustomerId: string;
    mercuryCustomerName: string;
    mercuryCustomerEmail: string;
    moderntaxClientId: string | null;
    moderntaxClientName: string | null;
    matchedBy: 'email' | 'name' | 'none';
  }[];
  invoicesByClient: {
    clientName: string;
    clientId: string | null;
    mercuryInvoices: {
      mercuryInvoiceId: string;
      invoiceNumber: string;
      amount: number;
      status: string;
      invoiceDate: string;
      dueDate: string;
      moderntaxInvoiceId: string | null;
      action: 'linked-existing' | 'created' | 'skipped-no-client' | 'skipped-error';
      error?: string;
    }[];
  }[];
  totals: {
    mercuryCustomers: number;
    mercuryInvoices: number;
    matchedClients: number;
    paidAmountTotal: number;
    unpaidAmountTotal: number;
    created: number;
    linkedExisting: number;
    skipped: number;
  };
};

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.MERCURY_API_KEY) {
    return NextResponse.json({ error: 'MERCURY_API_KEY not configured' }, { status: 500 });
  }

  const supabase = createAdminClient();

  // Pull Mercury side
  let mercuryCustomers, mercuryInvoices;
  try {
    [mercuryCustomers, mercuryInvoices] = await Promise.all([
      listMercuryCustomers(),
      listMercuryInvoices(),
    ]);
  } catch (err) {
    return NextResponse.json(
      { error: 'Mercury API call failed', details: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // Pull our side — only billing columns we need for matching
  const { data: mtClients } = await supabase
    .from('clients')
    .select('id, name, billing_ap_email, mercury_customer_id' as any) as { data: any[] | null };

  const mtClientsList = mtClients || [];

  // Build lookup: email (lowercased) → client, name (lowercased, normalised) → client
  const byEmail = new Map<string, any>();
  const byName = new Map<string, any>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const c of mtClientsList) {
    if (c.billing_ap_email) byEmail.set(c.billing_ap_email.toLowerCase(), c);
    if (c.name) byName.set(norm(c.name), c);
  }

  const report: ReconcileReport = {
    clientMatches: [],
    invoicesByClient: [],
    totals: {
      mercuryCustomers: mercuryCustomers.length,
      mercuryInvoices: mercuryInvoices.length,
      matchedClients: 0,
      paidAmountTotal: 0,
      unpaidAmountTotal: 0,
      created: 0,
      linkedExisting: 0,
      skipped: 0,
    },
  };

  // Match each Mercury customer to a ModernTax client
  const mercuryCustToMtClient = new Map<string, any>();
  for (const mc of mercuryCustomers) {
    let mt = byEmail.get((mc.email || '').toLowerCase());
    let matchedBy: 'email' | 'name' | 'none' = 'email';
    if (!mt) {
      mt = byName.get(norm(mc.name || ''));
      matchedBy = mt ? 'name' : 'none';
    }
    if (mt) mercuryCustToMtClient.set(mc.id, mt);
    report.clientMatches.push({
      mercuryCustomerId: mc.id,
      mercuryCustomerName: mc.name,
      mercuryCustomerEmail: mc.email,
      moderntaxClientId: mt?.id ?? null,
      moderntaxClientName: mt?.name ?? null,
      matchedBy,
    });

    // Persist the mercury_customer_id mapping so future auto-invoices skip the lookup.
    if (mt && !mt.mercury_customer_id) {
      await (supabase.from('clients') as any)
        .update({ mercury_customer_id: mc.id })
        .eq('id', mt.id);
    }
  }
  report.totals.matchedClients = report.clientMatches.filter(m => m.moderntaxClientId).length;

  // Group Mercury invoices by ModernTax client, upsert into invoices table
  const byMtClient = new Map<string, any[]>();
  for (const inv of mercuryInvoices) {
    const mt = mercuryCustToMtClient.get(inv.customerId);
    const key = mt?.id ?? '__unmatched__';
    const arr = byMtClient.get(key) ?? [];
    arr.push({ invoice: inv, mtClient: mt });
    byMtClient.set(key, arr);
  }

  for (const [mtClientId, invList] of byMtClient) {
    const mtClient = invList[0].mtClient;
    const clientReport: ReconcileReport['invoicesByClient'][number] = {
      clientName: mtClient?.name ?? '(unmatched Mercury customers)',
      clientId: mtClientId === '__unmatched__' ? null : mtClientId,
      mercuryInvoices: [],
    };

    for (const { invoice: inv, mtClient: mt } of invList) {
      // Track totals
      if (inv.status === 'Paid') report.totals.paidAmountTotal += inv.amount;
      else if (inv.status === 'Unpaid' || inv.status === 'Processing') report.totals.unpaidAmountTotal += inv.amount;

      if (!mt) {
        clientReport.mercuryInvoices.push({
          mercuryInvoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount,
          status: inv.status,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          moderntaxInvoiceId: null,
          action: 'skipped-no-client',
        });
        report.totals.skipped += 1;
        continue;
      }

      // Check if we already have an invoice row for this Mercury invoice
      const { data: existing } = await (supabase.from('invoices') as any)
        .select('id')
        .eq('mercury_invoice_id', inv.id)
        .maybeSingle();

      if (existing?.id) {
        // Already linked. Refresh status + sent_at if we had it as draft.
        await (supabase.from('invoices') as any)
          .update({
            status: inv.status === 'Paid' ? 'paid' : inv.status === 'Unpaid' ? 'sent' : inv.status.toLowerCase(),
            paid_at: inv.status === 'Paid' ? new Date().toISOString() : undefined,
            mercury_invoice_slug: inv.slug,
            mercury_pay_url: getMercuryPayUrl(inv.slug),
            mercury_pdf_url: getMercuryInvoicePdfUrl(inv.slug),
          })
          .eq('id', existing.id);
        clientReport.mercuryInvoices.push({
          mercuryInvoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount,
          status: inv.status,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          moderntaxInvoiceId: existing.id,
          action: 'linked-existing',
        });
        report.totals.linkedExisting += 1;
        continue;
      }

      // Create a new invoice row mirroring Mercury
      const periodStart = inv.servicePeriodStartDate || inv.invoiceDate;
      const periodEnd   = inv.servicePeriodEndDate   || inv.invoiceDate;
      const statusMap: Record<string, string> = {
        Paid: 'paid', Unpaid: 'sent', Cancelled: 'cancelled', Processing: 'processing',
      };
      const { data: inserted, error: insertErr } = await (supabase.from('invoices') as any)
        .insert({
          client_id: mt.id,
          invoice_number: inv.invoiceNumber,
          billing_period_start: periodStart,
          billing_period_end: periodEnd,
          total_entities: 0,   // unknown from Mercury side; our cron populates this going forward
          total_amount: inv.amount,
          status: statusMap[inv.status] ?? 'sent',
          payment_method: 'ach',
          due_date: inv.dueDate,
          sent_at: inv.createdAt,
          paid_at: inv.status === 'Paid' ? new Date().toISOString() : null,
          mercury_reference: inv.invoiceNumber,
          mercury_invoice_id: inv.id,
          mercury_invoice_slug: inv.slug,
          mercury_pay_url: getMercuryPayUrl(inv.slug),
          mercury_pdf_url: getMercuryInvoicePdfUrl(inv.slug),
          notes: 'Backfilled from Mercury by /api/admin/mercury-reconcile',
        })
        .select('id')
        .single();

      if (insertErr || !inserted) {
        clientReport.mercuryInvoices.push({
          mercuryInvoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount,
          status: inv.status,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          moderntaxInvoiceId: null,
          action: 'skipped-error',
          error: insertErr?.message || 'insert failed',
        });
        report.totals.skipped += 1;
        continue;
      }

      clientReport.mercuryInvoices.push({
        mercuryInvoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount,
        status: inv.status,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        moderntaxInvoiceId: inserted.id,
        action: 'created',
      });
      report.totals.created += 1;
    }

    clientReport.mercuryInvoices.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
    report.invoicesByClient.push(clientReport);
  }

  // Round dollar totals to cents
  report.totals.paidAmountTotal = Math.round(report.totals.paidAmountTotal * 100) / 100;
  report.totals.unpaidAmountTotal = Math.round(report.totals.unpaidAmountTotal * 100) / 100;

  return NextResponse.json(report, { status: 200 });
}
