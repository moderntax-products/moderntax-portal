/**
 * GET /api/cron/send-may-2026-monitoring-stripe
 *
 * One-shot Vercel cron — fires Wednesday 2026-05-28 at 15:00 UTC (8 AM PT)
 * to auto-charge the monitoring portion of May 2026 invoices via Stripe
 * (saved card on file).
 *
 * Driver: Matt's 2026-05-22 directive split the May billing:
 *   - Mercury (verification + pre-bill) → fired 2026-05-23
 *   - Stripe (monitoring) → fires 2026-05-28 (this cron — first business
 *     day after Memorial Day weekend so card statements settle clean)
 *
 * Per client:
 *   1. Find the May invoice for the client with monitoring_amount > 0 and
 *      no -MON sibling yet (idempotency guard — re-fires no-op).
 *   2. Insert a NEW invoice row `INV-2026-05-{SLUG}-MON` for the monitoring
 *      portion only.
 *   3. Stripe off_session PaymentIntent against client.stripe_payment_method_id.
 *   4. On success: mark -MON row paid + flip the base invoice to
 *      "verification + pre-bill only" totals (drop monitoring amount,
 *      so the two rows sum to the original combined total).
 *
 * Date-guarded: returns skip on any date other than 2026-05-28 so this
 * Vercel cron entry can remain in vercel.json indefinitely.
 *
 * Auth: CRON_SECRET only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { getStripe, findOrCreateStripeCustomer } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TARGET_DATE_UTC = '2026-05-28';
const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';
const TARGET_CLIENT_NAMES = ['Centerstone SBA Lending', 'California Statewide CDC'];

export async function GET(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;

  const todayUtc = new Date().toISOString().slice(0, 10);
  if (todayUtc !== TARGET_DATE_UTC) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: `Today (${todayUtc}) is not the target Wednesday (${TARGET_DATE_UTC}). Endpoint is one-shot.`,
    });
  }

  const admin = createAdminClient();
  const results: any[] = [];
  let totalCharged = 0;

  for (const clientName of TARGET_CLIENT_NAMES) {
    const r: any = { client: clientName, status: 'pending' };
    try {
      // 1. Load client
      const { data: c } = await admin.from('clients')
        .select('id, name, slug, stripe_customer_id, stripe_payment_method_id, payment_method_status, ' +
          'payment_method_brand, payment_method_last4, billing_ap_email, address_line1, address_line2, ' +
          'address_city, address_state, address_postal_code, address_country')
        .eq('name', clientName).single() as { data: any };
      if (!c) { r.status = 'client_not_found'; results.push(r); continue; }
      if (!c.stripe_payment_method_id || c.payment_method_status !== 'active') {
        r.status = 'no_active_payment_method';
        r.payment_method_status = c.payment_method_status;
        results.push(r); continue;
      }

      // 2. Load May base invoice
      const { data: baseInvoice } = await admin.from('invoices')
        .select('id, invoice_number, total_amount, monitoring_amount, monitoring_entities, due_date')
        .eq('client_id', c.id).eq('billing_period_start', PERIOD_START).eq('billing_period_end', PERIOD_END)
        .not('invoice_number', 'like', '%-MON').single() as { data: any };
      if (!baseInvoice) { r.status = 'no_base_invoice'; results.push(r); continue; }
      const monitoringAmount = Number(baseInvoice.monitoring_amount || 0);
      if (monitoringAmount <= 0) { r.status = 'no_monitoring_to_bill'; results.push(r); continue; }
      r.monitoring_amount = monitoringAmount;

      // 3. Idempotency: bail if -MON row already exists + paid
      const monInvoiceNumber = `${baseInvoice.invoice_number}-MON`;
      const { data: existingMon } = await admin.from('invoices')
        .select('id, stripe_payment_intent_id, paid_at')
        .eq('invoice_number', monInvoiceNumber).maybeSingle() as { data: any };
      if (existingMon?.stripe_payment_intent_id) {
        r.status = 'already_charged';
        r.stripe_pi = existingMon.stripe_payment_intent_id;
        r.paid_at = existingMon.paid_at;
        results.push(r); continue;
      }

      // 4. Insert -MON invoice row (or reuse if exists from a partial run)
      let monInvoiceId = existingMon?.id || null;
      if (!monInvoiceId) {
        const { data: ins, error: insErr } = await admin.from('invoices').insert({
          client_id: c.id,
          invoice_number: monInvoiceNumber,
          billing_period_start: PERIOD_START,
          billing_period_end: PERIOD_END,
          total_entities: baseInvoice.monitoring_entities || 0,
          total_amount: monitoringAmount,
          monitoring_entities: baseInvoice.monitoring_entities || 0,
          monitoring_amount: monitoringAmount,
          status: 'draft',
          // payment_method='stripe' isn't allowed yet (constraint widened in
          // migration-invoices-payment-method-stripe.sql). Leave null; paid_via
          // captures the true source post-charge.
          payment_method: null,
          due_date: baseInvoice.due_date,
          notes: `Monitoring portion of May invoice — auto-charged via Stripe (${c.payment_method_brand} ending ${c.payment_method_last4}).`,
        }).select('id').single() as { data: any; error: any };
        if (insErr) {
          r.status = 'insert_failed';
          r.error = insErr.message;
          results.push(r); continue;
        }
        monInvoiceId = ins.id;
      }
      r.invoice_id = monInvoiceId;
      r.invoice_number = monInvoiceNumber;

      // 5. Stripe charge
      const stripe = getStripe();
      const customerId = await findOrCreateStripeCustomer(c, admin);
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(monitoringAmount * 100),
        currency: 'usd',
        customer: customerId,
        payment_method: c.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        description: `ModernTax — ${c.name} — May 2026 Account Monitoring (${baseInvoice.monitoring_entities} entities)`,
        metadata: {
          moderntax_invoice_id: monInvoiceId,
          moderntax_client_id: c.id,
          billing_period: '2026-05',
          line_kind: 'monitoring',
        },
        statement_descriptor_suffix: 'MONITORING',
      });

      // 6. Update -MON invoice row with Stripe refs + status
      const succeeded = pi.status === 'succeeded';
      await (admin.from('invoices') as any).update({
        stripe_payment_intent_id: pi.id,
        stripe_charge_id: typeof pi.latest_charge === 'string' ? pi.latest_charge : null,
        status: succeeded ? 'paid' : 'sent',
        sent_at: new Date().toISOString(),
        paid_at: succeeded ? new Date().toISOString() : null,
        paid_via: succeeded ? 'stripe' : null,
      }).eq('id', monInvoiceId);

      // 7. Update base invoice to drop monitoring (so totals reconcile across
      // the two rows). Only do this on charge success — if Stripe declined,
      // leave the base row with monitoring still attributed so it doesn't get
      // lost in the books.
      if (succeeded) {
        const newBaseTotal = Math.round((Number(baseInvoice.total_amount) - monitoringAmount) * 100) / 100;
        await (admin.from('invoices') as any).update({
          total_amount: newBaseTotal,
          monitoring_entities: 0,
          monitoring_amount: 0,
          notes: 'Verification + pre-billed pending entities. Monitoring billed separately via Stripe (see -MON sibling).',
        }).eq('id', baseInvoice.id);
      }

      r.status = pi.status;
      r.stripe_pi = pi.id;
      r.paid_via = succeeded ? 'stripe' : null;
      totalCharged += succeeded ? monitoringAmount : 0;
    } catch (err: any) {
      r.status = 'failed';
      r.error = err?.message || String(err);
    }
    results.push(r);
  }

  return NextResponse.json({
    success: results.every(r => ['succeeded', 'already_charged', 'no_monitoring_to_bill'].includes(r.status)),
    date_fired: todayUtc,
    total_charged: Math.round(totalCharged * 100) / 100,
    results,
  });
}
