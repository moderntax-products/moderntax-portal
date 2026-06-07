/**
 * POST /api/billing/pay-now
 *
 * Manager triggers an early Mercury invoice for the current month's
 * accumulated billable usage (instead of waiting for the 1st-of-month
 * auto-invoice cron). Returns the Mercury hosted pay URL so the manager
 * can complete ACH/wire payment immediately.
 *
 * Flow:
 *   1. Auth check — manager only, scoped to their client_id.
 *   2. Sum this month's completed-and-billable entities (excludes the
 *      first-3 free-trial carveout).
 *   3. Find-or-create Mercury customer for the client.
 *   4. Create a Mercury invoice for the running total (ACH-debit on,
 *      net-0 due date so the pay link works immediately).
 *   5. Insert an `invoices` row with status=sent + mercury_pay_url so the
 *      Invoice History table picks it up.
 *
 * Returns: { pay_url, invoice_number, amount }
 *
 * Idempotency: if a "manual" invoice for the current month already
 * exists in the unpaid state, return its pay URL instead of creating a
 * duplicate.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import {
  findOrCreateMercuryCustomer,
  createMercuryInvoice,
  getDestinationAccountId,
  getMercuryPayUrl,
  getMercuryInvoicePdfUrl,
} from '@/lib/mercury';

export async function POST() {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, client_id')
    .eq('id', user.id)
    .single() as { data: { role: string; client_id: string | null } | null; error: any };

  if (!profile || !['manager', 'admin'].includes(profile.role) || !profile.client_id) {
    return NextResponse.json({ error: 'Manager-only' }, { status: 403 });
  }

  const admin = createAdminClient();

  // Pull client + current billing settings
  const { data: client } = await (admin.from('clients' as any) as any)
    .select('id, name, slug, free_trial, mercury_customer_id, billing_ap_email, billing_ap_phone, billing_rate_pdf, billing_rate_csv, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
    .eq('id', profile.client_id)
    .single();

  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const ratePdf = Number(client.billing_rate_pdf) || 99.99;
  const rateCsv = Number(client.billing_rate_csv) || 99.99;

  // Compute current month's billable total
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const { data: monthEntities } = await (admin
    .from('request_entities' as any) as any)
    .select('id, completed_at, requests!inner(intake_method, client_id)')
    .eq('requests.client_id', client.id)
    .eq('status', 'completed')
    .gte('completed_at', monthStart.toISOString())
    .lte('completed_at', monthEnd.toISOString());

  // Free trial: exclude first 3 entities account-wide (sorted by completion)
  let freeIds = new Set<string>();
  if (client.free_trial) {
    const { data: allCompleted } = await (admin
      .from('request_entities' as any) as any)
      .select('id, completed_at, requests!inner(client_id)')
      .eq('requests.client_id', client.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: true })
      .limit(3);
    freeIds = new Set((allCompleted || []).map((e: any) => e.id));
  }

  const billable = (monthEntities || []).filter((e: any) => !freeIds.has(e.id));
  const totalAmount = billable.reduce((sum: number, e: any) => {
    const rate = e.requests?.intake_method === 'csv' ? rateCsv : ratePdf;
    return sum + rate;
  }, 0);

  if (billable.length === 0) {
    return NextResponse.json({
      error: 'No billable entities this month yet',
      detail: client.free_trial
        ? `Your free trial is active. New entities are free until you've used your 3 trial credits.`
        : `No completed entities this month — nothing to bill.`,
    }, { status: 400 });
  }

  // Idempotency: if there's an unpaid manual-paid invoice for this month,
  // return it. The billing_kind column is added by migration-billing-kind.sql;
  // we wrap in try/catch so the route still works before the migration runs
  // (in that case we just skip the idempotency check — paying twice is
  // recoverable since Mercury sends new invoices each call).
  try {
    const { data: existingInvoice } = await (admin.from('invoices' as any) as any)
      .select('id, mercury_pay_url, invoice_number, total_amount, status')
      .eq('client_id', client.id)
      .eq('billing_kind', 'manual')
      .gte('billing_period_start', monthStart.toISOString().slice(0, 10))
      .lte('billing_period_end', monthEnd.toISOString().slice(0, 10))
      .neq('status', 'paid')
      .limit(1)
      .maybeSingle();

    if (existingInvoice && existingInvoice.mercury_pay_url) {
      return NextResponse.json({
        pay_url: existingInvoice.mercury_pay_url,
        invoice_number: existingInvoice.invoice_number,
        amount: Number(existingInvoice.total_amount),
        already_existed: true,
      });
    }
  } catch (err) {
    // billing_kind column doesn't exist yet — skip idempotency check.
    console.warn('[pay-now] billing_kind idempotency check skipped:', err);
  }

  // Mercury setup
  let mercuryCustomerId: string = client.mercury_customer_id;
  if (!mercuryCustomerId) {
    if (!client.billing_ap_email) {
      return NextResponse.json({
        error: 'Set up billing first',
        detail: 'Add an AP email and billing address in Payment Settings, then click "Save & Enroll in Auto-Pay" before paying.',
      }, { status: 400 });
    }
    const customer = await findOrCreateMercuryCustomer({
      name: client.name,
      email: client.billing_ap_email,
      address: client.address_line1
        ? {
            name: client.name,
            address1: client.address_line1,
            address2: client.address_line2 || null,
            city: client.address_city || '',
            region: client.address_state || '',
            postalCode: client.address_postal_code || '',
            country: client.address_country || 'US',
          }
        : undefined,
    });
    mercuryCustomerId = customer.id;
    await (admin.from('clients' as any) as any)
      .update({ mercury_customer_id: mercuryCustomerId })
      .eq('id', client.id);
  }

  // Build line items grouped by intake_method
  const csvCount = billable.filter((e: any) => e.requests?.intake_method === 'csv').length;
  const pdfCount = billable.length - csvCount;
  const lineItems: { name: string; unitPrice: number; quantity: number }[] = [];
  if (csvCount > 0) lineItems.push({ name: `IRS Transcript Verification (CSV upload) — ${client.name}`, unitPrice: rateCsv, quantity: csvCount });
  if (pdfCount > 0) lineItems.push({ name: `IRS Transcript Verification (Signed 8821 PDF) — ${client.name}`, unitPrice: ratePdf, quantity: pdfCount });

  const todayIso = now.toISOString().slice(0, 10);
  const dueIso = todayIso; // pay-now invoices are due immediately

  let invoiceNumber: string;
  let mercuryInvoice;
  try {
    mercuryInvoice = await createMercuryInvoice({
      customerId: mercuryCustomerId,
      destinationAccountId: getDestinationAccountId(),
      invoiceDate: todayIso,
      dueDate: dueIso,
      invoiceNumber: `MT-${client.slug?.toUpperCase() || 'CLI'}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-PAYNOW-${Date.now().toString().slice(-6)}`,
      lineItems,
      ccEmails: [client.billing_ap_email].filter(Boolean),
      payerMemo: `Manual pay-now request for ${now.toLocaleString('en-US', { month: 'long', year: 'numeric' })} usage to date.`,
      internalNote: `Triggered via portal /invoicing Pay Now by ${user.email}`,
      sendEmailOption: 'SendNow',
    });
    invoiceNumber = mercuryInvoice.invoiceNumber;
  } catch (err: any) {
    return NextResponse.json({
      error: 'Failed to create Mercury invoice',
      detail: err?.message || String(err),
    }, { status: 500 });
  }

  // Persist invoice row so it shows up in Invoice History.
  // billing_kind is optional — added by migration-billing-kind.sql; we
  // first try to insert with it, and fall back to inserting without if
  // the column doesn't exist yet (Postgres returns 42703 column-missing).
  const baseInsert = {
    client_id: client.id,
    invoice_number: invoiceNumber,
    billing_period_start: monthStart.toISOString().slice(0, 10),
    billing_period_end: monthEnd.toISOString().slice(0, 10),
    total_entities: billable.length,
    monitoring_entities: 0,
    total_amount: totalAmount,
    monitoring_amount: 0,
    status: 'sent',
    due_date: dueIso,
    payment_method: 'ach',
    mercury_invoice_id: mercuryInvoice.id,
    mercury_invoice_slug: mercuryInvoice.slug,
    mercury_pay_url: getMercuryPayUrl(mercuryInvoice.slug),
    mercury_pdf_url: getMercuryInvoicePdfUrl(mercuryInvoice.slug),
  };
  let insertedInvoice: { id: string } | null = null;
  {
    const first = await (admin.from('invoices' as any) as any)
      .insert({ ...baseInsert, billing_kind: 'manual' })
      .select('id')
      .single();
    if (first.error) {
      // Retry without billing_kind in case the migration hasn't run yet.
      const second = await (admin.from('invoices' as any) as any)
        .insert(baseInsert)
        .select('id')
        .single();
      insertedInvoice = second.data || null;
    } else {
      insertedInvoice = first.data || null;
    }
  }

  return NextResponse.json({
    success: true,
    pay_url: getMercuryPayUrl(mercuryInvoice.slug),
    pdf_url: getMercuryInvoicePdfUrl(mercuryInvoice.slug),
    invoice_number: invoiceNumber,
    amount: totalAmount,
    invoice_id: insertedInvoice?.id,
  });
}
