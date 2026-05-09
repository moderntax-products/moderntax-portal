/**
 * Resync Draft Invoices to Mercury
 *
 * Background:
 *   The May 1 auto-invoice cron created `status='draft'` rows for every client
 *   but Mercury sync silently failed because the local egress IP wasn't on
 *   Mercury's allowlist. Cron's try/catch swallowed the error and moved on.
 *   With the allowlist fixed, this endpoint finishes the job — replays the
 *   Mercury creation logic for every still-draft row and flips it to 'sent'.
 *
 * Behavior:
 *   - Walks every invoice with status='draft' (optionally filtered by clientId).
 *   - Skips clients with no billing_ap_email (logs a warning).
 *   - Reuses billing_ap_email_cc as the Mercury ccEmails list.
 *   - Idempotent: a draft that already has mercury_invoice_id is skipped.
 *
 * Auth:
 *   Bearer CRON_SECRET (matches the auto-invoice cron's auth model so the
 *   same secret rotation covers both).
 *
 * Method: POST (GET works too for ease of curl-from-shell).
 *   ?clientId=<uuid>  — only resync that client's drafts (optional)
 *   ?dryRun=1         — preview what would happen without calling Mercury
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import {
  createMercuryInvoice,
  findOrCreateMercuryCustomer,
  getDestinationAccountId,
  getMercuryInvoicePdfUrl,
  getMercuryPayUrl,
} from '@/lib/mercury';
import { requireBearer } from '@/lib/auth-util';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ResyncReport = {
  totals: {
    drafts: number;
    sent: number;
    skipped: number;
    failed: number;
  };
  results: {
    invoiceId: string;
    invoiceNumber: string;
    clientName: string;
    action: 'sent' | 'skipped-no-email' | 'skipped-already-mercury' | 'skipped-dry-run' | 'failed';
    mercuryInvoiceId?: string;
    payUrl?: string;
    error?: string;
  }[];
};

async function handle(request: NextRequest) {
  const unauthorized = requireBearer(request, process.env.CRON_SECRET);
  if (unauthorized) return unauthorized;
  if (!process.env.MERCURY_API_KEY) {
    return NextResponse.json({ error: 'MERCURY_API_KEY not configured' }, { status: 500 });
  }

  const url = new URL(request.url);
  const filterClientId = url.searchParams.get('clientId');
  const dryRun = url.searchParams.get('dryRun') === '1';

  const supabase = createAdminClient();

  // Pull every draft invoice + its client billing config in one shot.
  let q = supabase
    .from('invoices')
    .select(
      'id, invoice_number, client_id, billing_period_start, billing_period_end, ' +
      'total_entities, total_amount, monitoring_entities, monitoring_amount, ' +
      'due_date, mercury_invoice_id, ' +
      'clients ( id, name, slug, billing_ap_email, billing_ap_email_cc, billing_net_days, ' +
      'mercury_customer_id, address_line1, address_line2, address_city, address_state, ' +
      'address_postal_code, address_country )',
    )
    .eq('status', 'draft');
  if (filterClientId) q = q.eq('client_id', filterClientId);
  const { data: drafts, error: draftsError } = (await q) as { data: any[] | null; error: any };

  if (draftsError) {
    return NextResponse.json(
      { error: 'Failed to load drafts', details: draftsError.message },
      { status: 500 },
    );
  }

  const report: ResyncReport = {
    totals: { drafts: drafts?.length || 0, sent: 0, skipped: 0, failed: 0 },
    results: [],
  };

  for (const inv of drafts || []) {
    const client = inv.clients;
    if (!client) {
      report.totals.skipped++;
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: '(unknown)',
        action: 'failed',
        error: 'no client row joined',
      });
      continue;
    }

    // Already linked to Mercury? Don't double-fire.
    if (inv.mercury_invoice_id) {
      report.totals.skipped++;
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: client.name,
        action: 'skipped-already-mercury',
        mercuryInvoiceId: inv.mercury_invoice_id,
      });
      continue;
    }

    // No AP email — Mercury requires a recipient.
    if (!client.billing_ap_email) {
      report.totals.skipped++;
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: client.name,
        action: 'skipped-no-email',
        error: 'client.billing_ap_email is null',
      });
      continue;
    }

    if (dryRun) {
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: client.name,
        action: 'skipped-dry-run',
      });
      continue;
    }

    try {
      // Ensure Mercury customer exists.
      let mercuryCustomerId = client.mercury_customer_id;
      if (!mercuryCustomerId) {
        const customer = await findOrCreateMercuryCustomer({
          name: client.name,
          email: client.billing_ap_email,
          address: client.address_line1 ? {
            name: client.name,
            address1: client.address_line1,
            address2: client.address_line2 || null,
            city: client.address_city || '',
            region: client.address_state || '',
            postalCode: client.address_postal_code || '',
            country: (client.address_country || 'US') as string,
          } : undefined,
        });
        mercuryCustomerId = customer.id;
        await (supabase.from('clients') as any)
          .update({ mercury_customer_id: customer.id })
          .eq('id', client.id);
      }

      // Build line items from the persisted totals. We don't have the
      // per-intake-method breakdown here — collapse to an average unit price
      // so the invoice total still matches the row exactly.
      const lineItems: { name: string; unitPrice: number; quantity: number }[] = [];
      const verificationAmount = Number(inv.total_amount) - Number(inv.monitoring_amount || 0);
      const verificationEntities = Number(inv.total_entities || 0) - Number(inv.monitoring_entities || 0);
      if (verificationEntities > 0 && verificationAmount > 0) {
        lineItems.push({
          name: `IRS Transcript Verification (${inv.billing_period_start} → ${inv.billing_period_end})`,
          unitPrice: Math.round((verificationAmount / verificationEntities) * 100) / 100,
          quantity: verificationEntities,
        });
      } else if (verificationAmount > 0) {
        // Subscription-style flat fee — single line.
        lineItems.push({
          name: `Monthly Service (${inv.billing_period_start} → ${inv.billing_period_end})`,
          unitPrice: verificationAmount,
          quantity: 1,
        });
      }
      if (Number(inv.monitoring_entities || 0) > 0 && Number(inv.monitoring_amount || 0) > 0) {
        lineItems.push({
          name: `Account Monitoring (${inv.billing_period_start} → ${inv.billing_period_end})`,
          unitPrice: Math.round((Number(inv.monitoring_amount) / Number(inv.monitoring_entities)) * 100) / 100,
          quantity: Number(inv.monitoring_entities),
        });
      }

      if (lineItems.length === 0) {
        report.totals.skipped++;
        report.results.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          clientName: client.name,
          action: 'failed',
          error: 'no billable line items on draft',
        });
        continue;
      }

      const netDays = client.billing_net_days ?? 5;
      const invoiceDate = new Date().toISOString().split('T')[0];

      const mercuryInvoice = await createMercuryInvoice({
        customerId: mercuryCustomerId!,
        destinationAccountId: getDestinationAccountId(),
        dueDate: inv.due_date,
        invoiceDate,
        invoiceNumber: inv.invoice_number,
        lineItems,
        ccEmails: client.billing_ap_email_cc || [],
        creditCardEnabled: false,
        achDebitEnabled: true,
        useRealAccountNumber: false,
        sendEmailOption: 'SendNow',
        servicePeriodStartDate: inv.billing_period_start,
        servicePeriodEndDate: inv.billing_period_end,
        payerMemo: `Reference: ${inv.invoice_number}. Net ${netDays} days.`,
        internalNote: `Resynced from portal.moderntax.io draft (May 1 IP-allowlist remediation).`,
      });

      await supabase.from('invoices').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        mercury_reference: mercuryInvoice.invoiceNumber,
        mercury_invoice_id: mercuryInvoice.id,
        mercury_invoice_slug: mercuryInvoice.slug,
        mercury_pay_url: getMercuryPayUrl(mercuryInvoice.slug),
        mercury_pdf_url: getMercuryInvoicePdfUrl(mercuryInvoice.slug),
      }).eq('id', inv.id);

      // Auto-fire breakdown PDF exactly once per invoice (Matt 2026-05-04).
      // Idempotent via invoices.breakdown_sent_at column. Same code path as
      // the auto-invoice cron; future dunning emails skip this attachment.
      await sendBreakdownOnce(supabase, inv.id, client.name);

      report.totals.sent++;
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: client.name,
        action: 'sent',
        mercuryInvoiceId: mercuryInvoice.id,
        payUrl: getMercuryPayUrl(mercuryInvoice.slug),
      });
      console.log(
        `[resync] ${client.name} ${inv.invoice_number} → Mercury ${mercuryInvoice.id} ` +
        `($${inv.total_amount}, cc=${(client.billing_ap_email_cc || []).length})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.totals.failed++;
      report.results.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        clientName: client.name,
        action: 'failed',
        error: msg,
      });
      console.error(`[resync] ${client.name} ${inv.invoice_number} failed: ${msg}`);
    }
  }

  return NextResponse.json(report);
}

/**
 * Fire the itemized breakdown PDF to AP recipients exactly once per invoice.
 * Idempotent via `invoices.breakdown_sent_at`. Non-blocking on failure.
 */
async function sendBreakdownOnce(
  supabase: ReturnType<typeof createAdminClient>,
  invoiceId: string,
  clientName: string,
): Promise<void> {
  const { data: row } = await (supabase.from('invoices') as any)
    .select('breakdown_sent_at')
    .eq('id', invoiceId)
    .single();
  if (row?.breakdown_sent_at) {
    console.log(`[resync] ${clientName}: breakdown already sent (${row.breakdown_sent_at})`);
    return;
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
  const cronSecret = process.env.CRON_SECRET || '';
  try {
    const res = await fetch(`${appUrl}/api/admin/email-invoice-breakdown?invoiceId=${invoiceId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cronSecret}` },
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[resync] ${clientName}: breakdown send failed ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    await (supabase.from('invoices') as any)
      .update({ breakdown_sent_at: new Date().toISOString() })
      .eq('id', invoiceId);
    console.log(`[resync] ${clientName}: breakdown sent + stamped`);
  } catch (err) {
    console.error(`[resync] ${clientName}: breakdown send threw:`, err instanceof Error ? err.message : err);
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
