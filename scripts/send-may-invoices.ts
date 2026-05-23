/**
 * Send May 2026 invoices for Centerstone + California Statewide CDC.
 *
 * Driver: 2026-05-22 Matt's directive:
 *   - Auto-bill Stripe on-file for MONITORING fees
 *   - Mercury invoice link for VERIFICATION + PRE-BILL fees
 *   - Mercury invoices: NO credit-card option, NO ACH Credit option
 *     (achDebitEnabled=true, creditCardEnabled=false, useRealAccountNumber=false
 *      — when virtual account numbers are used, Mercury's pay page does NOT
 *      show the ACH Credit / wire panel. Only ACH Debit is offered.)
 *
 * Architecture:
 *   - Existing May invoice DB row (created by finalize-may-invoices.ts) becomes
 *     the VERIFICATION + PRE-BILL invoice → fires to Mercury.
 *   - NEW invoice DB row inserted for MONITORING portion → fires to Stripe
 *     off_session PaymentIntent against client.stripe_payment_method_id.
 *   - Both rows get the breakdown email (one combined or separate per-row).
 *
 * Modes:
 *   --dry-run         (default OFF) Don't actually charge Stripe or fire
 *                     Mercury. Print what would happen + amounts.
 *   --send-email      (default OFF) Send breakdown email after billing.
 *                     Default OFF so we can stage tonight and fire emails
 *                     tomorrow morning via /admin/billing button or this
 *                     script with --send-email.
 *   --client=<name>   (default both) Run only for one client.
 *
 * Run:
 *   # Tonight dry-run (validate):
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/send-may-invoices.ts --dry-run
 *
 *   # Tomorrow morning live fire (Stripe + Mercury + email):
 *   npx -y dotenv-cli -e .env.local -- npx tsx scripts/send-may-invoices.ts --send-email
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getStripe, findOrCreateStripeCustomer } from '../lib/stripe';
import {
  createMercuryInvoice,
  findOrCreateMercuryCustomer,
  getDestinationAccountId,
  getMercuryPayUrl,
  getMercuryInvoicePdfUrl,
} from '../lib/mercury';

const PERIOD_START = '2026-05-01';
const PERIOD_END   = '2026-05-31';
const TARGET_CLIENT_NAMES = ['Centerstone SBA Lending', 'California Statewide CDC'];

export interface CliFlags { dryRun: boolean; sendEmail: boolean; clientFilter: string | null; }
export const MAY_2026_TARGETS = TARGET_CLIENT_NAMES;

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  return {
    dryRun:       args.includes('--dry-run'),
    sendEmail:    args.includes('--send-email'),
    clientFilter: args.find(a => a.startsWith('--client='))?.split('=')[1] || null,
  };
}

export interface ProcessResult {
  clientName: string;
  monitoring: { invoiceId: string | null; amount: number; stripePaymentIntent: string | null; status: string; };
  mercury:    { invoiceId: string | null; amount: number; mercuryInvoiceId: string | null; payUrl: string | null; status: string; };
  emailSent:  boolean;
  errors:     string[];
}

async function main() {
  const flags = parseFlags();
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Sending May 2026 invoices — bifurcated Stripe (monitoring) + Mercury (verification)`);
  console.log(`Mode: ${flags.dryRun ? 'DRY RUN (no charges, no Mercury)' : 'LIVE'} | Email: ${flags.sendEmail ? 'YES' : 'NO'}`);
  console.log(`${'═'.repeat(80)}\n`);

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const results: ProcessResult[] = [];

  for (const name of TARGET_CLIENT_NAMES) {
    if (flags.clientFilter && !name.toLowerCase().includes(flags.clientFilter.toLowerCase())) continue;
    const r = await processClient(sb, name, flags);
    if (r) results.push(r);
  }

  // ----- Summary -----
  console.log(`\n${'═'.repeat(80)}\nSUMMARY\n${'═'.repeat(80)}`);
  let stripeTotal = 0, mercuryTotal = 0;
  for (const r of results) {
    console.log(`\n  ${r.clientName}`);
    console.log(`    Stripe (monitoring):    $${r.monitoring.amount.toFixed(2)}  ${r.monitoring.status}${r.monitoring.stripePaymentIntent ? ' (' + r.monitoring.stripePaymentIntent + ')' : ''}`);
    console.log(`    Mercury (verification): $${r.mercury.amount.toFixed(2)}  ${r.mercury.status}${r.mercury.payUrl ? '\n      pay url: ' + r.mercury.payUrl : ''}`);
    console.log(`    Email sent:             ${r.emailSent ? 'yes' : 'no'}`);
    if (r.errors.length > 0) console.log(`    ! Errors: ${r.errors.join('; ')}`);
    stripeTotal  += r.monitoring.amount;
    mercuryTotal += r.mercury.amount;
  }
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Total via Stripe:  $${stripeTotal.toFixed(2)}  (auto-charged to saved cards)`);
  console.log(`Total via Mercury: $${mercuryTotal.toFixed(2)}  (ACH Debit invoice — no CC, no ACH Credit option)`);
  console.log(`Combined:          $${(stripeTotal + mercuryTotal).toFixed(2)}`);
  console.log(`${'─'.repeat(80)}\n`);
}

export async function processClient(sb: SupabaseClient, clientName: string, flags: CliFlags): Promise<ProcessResult | null> {
  const errors: string[] = [];
  console.log(`\n${'─'.repeat(80)}\nClient: ${clientName}\n${'─'.repeat(80)}`);

  const { data: c } = await sb.from('clients')
    .select('id, name, slug, billing_payment_method, billing_net_days, billing_ap_email, billing_ap_email_cc, ' +
      'stripe_customer_id, stripe_payment_method_id, payment_method_status, payment_method_brand, payment_method_last4, ' +
      'mercury_customer_id, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
    .eq('name', clientName).single() as { data: any };
  if (!c) { console.error(`  ✗ Client not found`); return null; }

  // Existing May invoice (the combined row created by finalize-may-invoices.ts)
  const { data: combined } = await sb.from('invoices')
    .select('*')
    .eq('client_id', c.id).eq('billing_period_start', PERIOD_START).eq('billing_period_end', PERIOD_END)
    .is('mercury_invoice_id', null)  // not already sent to Mercury
    .order('created_at', { ascending: true }) as { data: any[] };
  if (!combined || combined.length === 0) { console.error(`  ✗ No unsent May draft invoice for ${clientName}`); return null; }
  const baseInvoice = combined[0];
  const monitoringInvoice = combined.find(i => i.invoice_number?.endsWith('-MON'));
  console.log(`  Base draft: ${baseInvoice.invoice_number} | total=$${baseInvoice.total_amount} | monitoring=$${baseInvoice.monitoring_amount}`);

  const monitoringAmount = Number(baseInvoice.monitoring_amount || 0);
  const verificationAndPrebillAmount = Math.round((Number(baseInvoice.total_amount) - monitoringAmount) * 100) / 100;
  console.log(`  Splits: Stripe (monitoring) $${monitoringAmount.toFixed(2)} | Mercury (verif+prebill) $${verificationAndPrebillAmount.toFixed(2)}`);

  const result: ProcessResult = {
    clientName: c.name,
    monitoring: { invoiceId: null, amount: monitoringAmount, stripePaymentIntent: null, status: 'pending' },
    mercury:    { invoiceId: baseInvoice.id, amount: verificationAndPrebillAmount, mercuryInvoiceId: null, payUrl: null, status: 'pending' },
    emailSent:  false,
    errors,
  };

  // -------- 1. STRIPE: auto-charge monitoring portion --------
  // CRITICAL: only update the base invoice (drop monitoring from its total)
  // AFTER the monitoring row is successfully created. Otherwise a failure
  // here leaves us with $0 monitoring AND no separate monitoring row, which
  // is what bit us on the first dry-run.
  let monitoringRowCreated = false;
  if (monitoringAmount > 0) {
    if (!c.stripe_payment_method_id || c.payment_method_status !== 'active') {
      const msg = `no active Stripe payment method on file (status=${c.payment_method_status})`;
      console.error(`  ✗ Cannot Stripe-charge monitoring: ${msg}`);
      errors.push(msg);
      result.monitoring.status = 'skipped';
    } else {
      const monInvoiceNumber = `${baseInvoice.invoice_number}-MON`;
      let monInvoiceId = monitoringInvoice?.id || null;
      if (!monInvoiceId) {
        // In dry-run mode we DON'T actually insert — just describe the action.
        if (flags.dryRun) {
          console.log(`  ◯ DRY RUN: would insert monitoring invoice row ${monInvoiceNumber} ($${monitoringAmount.toFixed(2)})`);
          monitoringRowCreated = true;  // pretend it succeeded for downstream logic
        } else {
          const { data: ins, error: insErr } = await sb.from('invoices').insert({
            client_id: c.id,
            invoice_number: monInvoiceNumber,
            billing_period_start: PERIOD_START,
            billing_period_end: PERIOD_END,
            total_entities: baseInvoice.monitoring_entities || 0,
            total_amount: monitoringAmount,
            monitoring_entities: baseInvoice.monitoring_entities || 0,
            monitoring_amount: monitoringAmount,
            status: 'draft',
            // payment_method is constrained to ('ach','wire') in the schema —
            // 'stripe' isn't an allowed value yet (see migration-invoices-payment-method-stripe.sql).
            // Leave null on insert; the paid_via column captures the true source
            // when the PaymentIntent clears.
            payment_method: null,
            due_date: baseInvoice.due_date,
            notes: `Monitoring portion of May invoice — auto-charged to saved ${c.payment_method_brand} ending ${c.payment_method_last4}.`,
          }).select('id').single() as { data: any; error: any };
          if (insErr) {
            console.error(`  ✗ Failed to insert monitoring invoice row:`, insErr.message);
            errors.push(`monitoring row insert: ${insErr.message}`);
            result.monitoring.status = 'failed';
          } else {
            monInvoiceId = ins.id;
            monitoringRowCreated = true;
          }
        }
      } else {
        monitoringRowCreated = true; // existing row from prior run
      }
      result.monitoring.invoiceId = monInvoiceId;

      if (flags.dryRun) {
        console.log(`  ◯ DRY RUN: would charge $${monitoringAmount.toFixed(2)} to ${c.payment_method_brand} •${c.payment_method_last4} (pm=${c.stripe_payment_method_id})`);
        result.monitoring.status = 'dry_run';
      } else if (monInvoiceId) {
        try {
          const stripe = getStripe();
          const customerId = await findOrCreateStripeCustomer(c, sb);
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
          console.log(`  ✓ Stripe PaymentIntent ${pi.id} (status=${pi.status})`);
          await sb.from('invoices').update({
            stripe_payment_intent_id: pi.id,
            stripe_charge_id: typeof pi.latest_charge === 'string' ? pi.latest_charge : null,
            status: pi.status === 'succeeded' ? 'paid' : 'sent',
            sent_at: new Date().toISOString(),
            paid_at: pi.status === 'succeeded' ? new Date().toISOString() : null,
            paid_via: pi.status === 'succeeded' ? 'stripe' : null,
          } as any).eq('id', monInvoiceId);
          result.monitoring.stripePaymentIntent = pi.id;
          result.monitoring.status = pi.status;
        } catch (err: any) {
          console.error(`  ✗ Stripe charge failed:`, err.message);
          errors.push(`stripe charge: ${err.message}`);
          result.monitoring.status = 'failed';
        }
      }
    }
  } else {
    console.log(`  · No monitoring portion (skipping Stripe)`);
    result.monitoring.status = 'no_amount';
  }

  // -------- 2. UPDATE base invoice to be verification+prebill only --------
  // Guard: only update if monitoring row was actually created (or dry-run).
  // Otherwise we'd zero out monitoring with no Stripe target ever taking it.
  if (monitoringAmount > 0 && monitoringRowCreated && !flags.dryRun) {
    await sb.from('invoices').update({
      total_amount: verificationAndPrebillAmount,
      monitoring_entities: 0,
      monitoring_amount: 0,
      notes: 'Verification + pre-billed pending entities. Monitoring billed separately via Stripe auto-charge.',
    } as any).eq('id', baseInvoice.id);
  }
  result.mercury.amount = verificationAndPrebillAmount;

  // -------- 3. MERCURY: invoice for verification + prebill portion --------
  if (verificationAndPrebillAmount > 0) {
    if (flags.dryRun) {
      console.log(`  ◯ DRY RUN: would create Mercury invoice for $${verificationAndPrebillAmount.toFixed(2)} (ACH Debit only, no CC, no ACH Credit)`);
      result.mercury.status = 'dry_run';
    } else {
      try {
        // Ensure Mercury customer exists
        let mercuryCustomerId = c.mercury_customer_id;
        if (!mercuryCustomerId) {
          const customer = await findOrCreateMercuryCustomer({
            name: c.name,
            email: c.billing_ap_email,
            address: c.address_line1 ? {
              name: c.name, address1: c.address_line1, address2: c.address_line2 || null,
              city: c.address_city || '', region: c.address_state || '', postalCode: c.address_postal_code || '',
              country: (c.address_country || 'US') as string,
            } : undefined,
          });
          mercuryCustomerId = customer.id;
          await (sb.from('clients') as any).update({ mercury_customer_id: customer.id }).eq('id', c.id);
        }

        // Build line items from the invoice's already-computed lines (we re-query
        // request_entities to render exact entity names on Mercury PDF).
        const lineItems = await buildMercuryLineItems(sb, c, baseInvoice);

        const mercuryInvoice = await createMercuryInvoice({
          customerId: mercuryCustomerId!,
          destinationAccountId: getDestinationAccountId(),
          dueDate: baseInvoice.due_date,
          invoiceDate: new Date().toISOString().split('T')[0],
          invoiceNumber: baseInvoice.invoice_number,
          lineItems,
          ccEmails: c.billing_ap_email_cc || [],
          // SAFETY OVERRIDES per Matt's 2026-05-22 directive:
          //   - creditCardEnabled=false  → no card option on pay page
          //   - achDebitEnabled=true     → ACH Debit available (payer enters bank, Mercury pulls)
          //   - useRealAccountNumber=false → virtual account numbers, which Mercury
          //     does NOT surface as a "Pay by ACH Credit / Wire" option on the pay page
          creditCardEnabled: false,
          achDebitEnabled: true,
          useRealAccountNumber: false,
          sendEmailOption: 'SendNow',
          servicePeriodStartDate: PERIOD_START,
          servicePeriodEndDate: PERIOD_END,
          payerMemo: `Reference: ${baseInvoice.invoice_number}. Net ${c.billing_net_days ?? 5} days. ACH Debit only.`,
          internalNote: `Auto-fired from scripts/send-may-invoices.ts. Verification + pre-bill portion only; monitoring billed via Stripe (intent=${result.monitoring.stripePaymentIntent || 'n/a'}).`,
        });

        await sb.from('invoices').update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          mercury_reference: mercuryInvoice.invoiceNumber,
          mercury_invoice_id: mercuryInvoice.id,
          mercury_invoice_slug: mercuryInvoice.slug,
          mercury_pay_url: getMercuryPayUrl(mercuryInvoice.slug),
          mercury_pdf_url: getMercuryInvoicePdfUrl(mercuryInvoice.slug),
        } as any).eq('id', baseInvoice.id);

        console.log(`  ✓ Mercury invoice ${mercuryInvoice.id} (slug=${mercuryInvoice.slug})`);
        console.log(`    pay url: ${getMercuryPayUrl(mercuryInvoice.slug)}`);
        result.mercury.mercuryInvoiceId = mercuryInvoice.id;
        result.mercury.payUrl = getMercuryPayUrl(mercuryInvoice.slug);
        result.mercury.status = 'sent';
      } catch (err: any) {
        console.error(`  ✗ Mercury invoice creation failed:`, err.message);
        errors.push(`mercury: ${err.message}`);
        result.mercury.status = 'failed';
      }
    }
  } else {
    console.log(`  · No Mercury portion (skipping)`);
    result.mercury.status = 'no_amount';
  }

  // -------- 4. Breakdown email --------
  if (flags.sendEmail && !flags.dryRun && result.mercury.status === 'sent') {
    // Use the existing admin email endpoint via internal call. Simpler than
    // duplicating the email template logic here.
    try {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://portal.moderntax.io';
      const secret  = process.env.CRON_SECRET;
      if (!secret) {
        console.warn(`  ! CRON_SECRET not set — skipping email send`);
      } else {
        const res = await fetch(`${baseUrl}/api/admin/email-invoice-breakdown?invoiceId=${baseInvoice.id}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (res.ok) {
          console.log(`  ✓ Breakdown email sent to ${c.billing_ap_email}`);
          result.emailSent = true;
        } else {
          const t = await res.text();
          console.warn(`  ! Email send returned ${res.status}: ${t.slice(0, 200)}`);
          errors.push(`email: ${res.status}`);
        }
      }
    } catch (err: any) {
      console.error(`  ✗ Email send failed:`, err.message);
      errors.push(`email: ${err.message}`);
    }
  }

  return result;
}

async function buildMercuryLineItems(sb: SupabaseClient, client: any, invoice: any): Promise<Array<{ name: string; unitPrice: number; quantity: number }>> {
  const items: Array<{ name: string; unitPrice: number; quantity: number }> = [];
  const ratePdf = Number(client.billing_rate_pdf || 59.98);

  // Completed in May (verification)
  const { data: completed } = await sb.from('request_entities')
    .select(`id, requests!inner(client_id)`)
    .eq('status', 'completed').eq('requests.client_id', client.id)
    .gte('completed_at', `${PERIOD_START}T00:00:00Z`).lte('completed_at', `${PERIOD_END}T23:59:59.999Z`) as { data: any[] };
  const completedCount = (completed || []).length;
  if (completedCount > 0) {
    items.push({
      name: `IRS Transcript Verification (${PERIOD_START} - ${PERIOD_END})`,
      unitPrice: ratePdf,
      quantity: completedCount,
    });
  }

  // Pre-billed (8821_sent at pre-bill time)
  const { data: prebills } = await sb.from('request_entities')
    .select(`id, requests!inner(client_id)`)
    .eq('requests.client_id', client.id)
    .eq('gross_receipts->pre_billed->>invoice_id', invoice.id) as { data: any[] };
  const prebillCount = (prebills || []).length;
  if (prebillCount > 0) {
    items.push({
      name: `Pre-billed Pending Entities (8821 sent, awaiting completion)`,
      unitPrice: ratePdf,
      quantity: prebillCount,
    });
  }

  return items;
}

// Only auto-run when invoked directly (via tsx / node), not when imported
// from the Next.js cron route. ESM doesn't have `require.main === module`,
// but checking process.argv[1] for the file basename is reliable.
const runDirectly = process.argv[1]?.endsWith('send-may-invoices.ts') || process.argv[1]?.endsWith('send-may-invoices.js');
if (runDirectly) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
