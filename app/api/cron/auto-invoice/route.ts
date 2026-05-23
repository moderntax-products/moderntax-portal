/**
 * Auto-Invoice Cron Job
 * Generates draft invoices for all clients for the previous month
 * GET /api/cron/auto-invoice
 *
 * Runs on the 1st of each month at 6:00 AM UTC (vercel.json)
 * Reuses the same invoice generation logic as POST /api/admin/invoices
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

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();

    // Calculate previous month
    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth(); // 0-indexed: current month
    // Previous month: if current month is January (0), go to December of previous year
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    // month is now 1-indexed for the previous month

    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0]; // last day of prev month
    const periodStartDate = new Date(periodStart);
    const periodEndDate = new Date(periodEnd + 'T23:59:59.999Z');

    // Get all clients (including Mercury + Stripe integration fields).
    // CRITICAL: exclude sandbox clients here — otherwise the monthly
    // auto-invoice cron will generate real Stripe/Mercury invoices for
    // synthetic prospect demo accounts (Vine, Builds Collective, Moxie).
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select(
        'id, name, slug, free_trial, billing_payment_method, billing_rate_pdf, billing_rate_csv, ' +
        'billing_rate_monitoring, billing_net_days, billing_ap_email, billing_ap_email_cc, ' +
        'billing_model, subscription_monthly_amount, subscription_included_entities, subscription_overage_rate, ' +
        'billing_effective_from, billing_notes, ' +
        'mercury_customer_id, ' +
        // Stripe payment-method-on-file fields. When stripe_payment_method_id
        // is set + status='active', the cron auto-charges via Stripe and
        // skips the Mercury invoice block.
        'stripe_customer_id, stripe_payment_method_id, payment_method_status, ' +
        'address_line1, address_line2, address_city, address_state, address_postal_code, address_country'
      )
      .not('slug', 'ilike', '%-sandbox') as {
        data: {
          id: string;
          name: string;
          slug: string;
          free_trial: boolean;
          billing_payment_method: string | null;
          billing_rate_pdf: number;
          billing_rate_csv: number;
          billing_rate_monitoring: number | null;
          billing_net_days: number | null;
          billing_ap_email: string | null;
          billing_ap_email_cc: string[] | null;
          billing_model: string | null;
          subscription_monthly_amount: number | null;
          subscription_included_entities: number | null;
          subscription_overage_rate: number | null;
          billing_effective_from: string | null;
          billing_notes: string | null;
          mercury_customer_id: string | null;
          address_line1: string | null;
          address_line2: string | null;
          address_city: string | null;
          address_state: string | null;
          address_postal_code: string | null;
          address_country: string | null;
        }[] | null;
        error: any;
      };

    if (clientsError || !clients) {
      console.error('Failed to fetch clients:', clientsError);
      return NextResponse.json(
        { error: 'Failed to fetch clients', details: clientsError?.message },
        { status: 500 }
      );
    }

    let invoicesGenerated = 0;
    let clientsProcessed = 0;
    let skipped = 0;
    const errors: { client: string; error: string }[] = [];
    const generated: { client: string; invoiceNumber: string; totalEntities: number; totalAmount: number }[] = [];

    for (const client of clients) {
      clientsProcessed++;

      try {
        // Check if invoice already exists for this period
        const { data: existing } = await supabase
          .from('invoices')
          .select('id')
          .eq('client_id', client.id)
          .eq('billing_period_start', periodStart)
          .eq('billing_period_end', periodEnd)
          .single();

        if (existing) {
          skipped++;
          continue;
        }

        // Get all completed entities for this client (need all-time for free trial calc)
        const { data: completedRequests } = await supabase
          .from('requests')
          .select('id, intake_method, request_entities(id, status, completed_at)')
          .eq('client_id', client.id) as { data: any[] | null; error: any };

        const ratePdf = client.billing_rate_pdf || 59.98;
        const rateCsv = client.billing_rate_csv || 69.98;

        // If free trial, identify first 3 completed entities all-time to exclude
        let freeEntityIds = new Set<string>();
        if (client.free_trial) {
          const allEntities = (completedRequests || [])
            .flatMap((r: any) =>
              (r.request_entities || []).map((e: any) => ({
                ...e,
                intake_method: r.intake_method,
                request_id: r.id,
              }))
            )
            .filter((e: any) => e.status !== 'failed')
            .sort(
              (a: any, b: any) =>
                new Date(a.completed_at || '9999').getTime() -
                new Date(b.completed_at || '9999').getTime()
            );
          freeEntityIds = new Set(allEntities.slice(0, 3).map((e: any) => e.id));
        }

        const isSubscription = client.billing_model === 'subscription';
        const subMonthly = client.subscription_monthly_amount || 0;
        const subIncluded = client.subscription_included_entities || 0;
        const subOverageRate = client.subscription_overage_rate || 0;

        // Effective-from guard — if the MSA started mid-period (e.g. Cal Statewide
        // signed 2026-04-21), only count entities completed on/after this date.
        // The invoice naturally becomes prorated for the partial month.
        const effectiveFrom: Date | null = client.billing_effective_from
          ? new Date(client.billing_effective_from)
          : null;
        // Use the later of periodStartDate and effectiveFrom as the billable floor.
        const billableStart = effectiveFrom && effectiveFrom > periodStartDate
          ? effectiveFrom
          : periodStartDate;

        // Calculate billable entities in the billing period
        let totalEntities = 0;
        let totalAmount = 0;
        let subscriptionAmount = 0;
        let subscriptionOverageEntities = 0;
        let subscriptionOverageAmount = 0;

        if (isSubscription) {
          // Subscription: flat monthly fee + per-entity overage above included cap.
          // Count ALL period entities (regardless of intake method) toward the cap.
          let periodEntities = 0;
          (completedRequests || []).forEach((req: any) => {
            const entities = req.request_entities || [];
            entities.forEach((entity: any) => {
              if (entity.status !== 'completed' || !entity.completed_at) return;
              const completedDate = new Date(entity.completed_at);
              if (completedDate < billableStart || completedDate > periodEndDate) return;
              periodEntities += 1;
            });
          });

          // Prorate the flat subscription fee if the MSA started mid-period.
          if (effectiveFrom && effectiveFrom > periodStartDate) {
            const totalDaysInMonth = new Date(year, month, 0).getDate();
            const billableDays = Math.max(
              1,
              Math.round((periodEndDate.getTime() - effectiveFrom.getTime()) / (24 * 3600 * 1000)) + 1,
            );
            subscriptionAmount = Math.round(subMonthly * (billableDays / totalDaysInMonth) * 100) / 100;
          } else {
            subscriptionAmount = subMonthly;
          }
          if (periodEntities > subIncluded) {
            subscriptionOverageEntities = periodEntities - subIncluded;
            subscriptionOverageAmount = subscriptionOverageEntities * subOverageRate;
          }
          totalEntities = periodEntities;          // for visibility on the invoice
          totalAmount = subscriptionAmount + subscriptionOverageAmount;
        } else {
          // Per-TIN: every completed entity in the period bills at the
          // client's contracted rate (`billing_rate_pdf`). Per Matt 2026-05-01
          // the prior CSV-vs-PDF split (CSV at +$10) wasn't in any signed
          // contract — Centerstone & TMC SOWs say "$59.98 flat per Complete
          // Verification" with "Reorders/updates: Same flat rate." We honor
          // that by using a single per-client rate. Monitoring re-pulls also
          // billed at the same flat rate (per contract "Reorders/updates").
          //
          // The `billing_rate_csv` column is now unused in pricing math; left
          // in place for backwards-compat with admin UI but the cron ignores
          // it. Remove the column when convenient.
          const baseRate = ratePdf;
          (completedRequests || []).forEach((req: any) => {
            const entities = req.request_entities || [];
            entities.forEach((entity: any) => {
              if (entity.status !== 'completed' || !entity.completed_at) return;
              const completedDate = new Date(entity.completed_at);
              if (completedDate < billableStart || completedDate > periodEndDate) return;
              if (freeEntityIds.has(entity.id)) return;

              totalEntities += 1;
              totalAmount += baseRate;
            });
          });
          // rateCsv reference kept silent so unused-var lint doesn't fire on
          // imports we still want available for future tiered pricing work.
          void rateCsv;
        }

        // --- Monitoring line: $N/TIN × (months of active enrollment) ---
        // MOD-205: bill active entity_monitoring subscriptions in addition to
        // verification entities. Prorate by fraction of the billing month the
        // entity was enrolled (enrolled_at ≤ period_end AND not cancelled before
        // period_start).
        const monitoringRate = client.billing_rate_monitoring ?? 25;
        let monitoringEntities = 0;
        let monitoringAmount = 0;
        const { data: activeMonitoring } = await supabase
          .from('entity_monitoring')
          .select('id, entity_id, enrolled_at, cancelled_at, status')
          .eq('client_id', client.id)
          .lte('enrolled_at', periodEndDate.toISOString())
          .or(`cancelled_at.is.null,cancelled_at.gte.${periodStart}`) as { data: any[] | null };

        const daysInMonth = new Date(year, month, 0).getDate();
        for (const m of (activeMonitoring || [])) {
          if (m.status === 'pending') continue;
          const enrolled = new Date(m.enrolled_at).getTime();
          const cancelled = m.cancelled_at ? new Date(m.cancelled_at).getTime() : Infinity;
          const windowStart = Math.max(enrolled, periodStartDate.getTime());
          const windowEnd   = Math.min(cancelled, periodEndDate.getTime() + 1);
          if (windowEnd <= windowStart) continue;
          const activeDays = Math.ceil((windowEnd - windowStart) / (24 * 3600 * 1000));
          const prorated = (Math.min(activeDays, daysInMonth) / daysInMonth) * monitoringRate;
          monitoringEntities += 1;
          monitoringAmount += prorated;
        }
        // Round each subtotal to cents
        monitoringAmount = Math.round(monitoringAmount * 100) / 100;

        // --- Cash-Flow Analysis Pack line: $49.99 × packs generated this period ---
        // Each cash_flow_pack lives on entity.gross_receipts.cash_flow_pack,
        // with billed=false until this cron picks it up. Idempotency: once we
        // mark billed=true the next run skips it. The pack price is captured
        // on the entity at generation time so a later price change doesn't
        // retroactively re-bill prior packs.
        const cashFlowPacks: Array<{ entityId: string; entityName: string; price: number; generated_at: string }> = [];
        let cashFlowAmount = 0;
        const { data: candidatesForCashFlow } = await supabase
          .from('request_entities')
          .select('id, entity_name, gross_receipts, requests!inner(client_id)')
          .eq('requests.client_id', client.id)
          .not('gross_receipts->cash_flow_pack', 'is', null) as { data: any[] | null };

        for (const ent of (candidatesForCashFlow || [])) {
          const pack = ent.gross_receipts?.cash_flow_pack;
          if (!pack || pack.billed === true) continue;
          if (!pack.generated_at) continue;
          const genAt = new Date(pack.generated_at);
          // Only bill packs generated in this billing window (or earlier
          // unbilled packs, which is the catch-up case for the very first run).
          if (genAt > periodEndDate) continue;
          const price = typeof pack.price === 'number' ? pack.price : 49.99;
          cashFlowPacks.push({
            entityId: ent.id,
            entityName: ent.entity_name,
            price,
            generated_at: pack.generated_at,
          });
          cashFlowAmount += price;
        }
        cashFlowAmount = Math.round(cashFlowAmount * 100) / 100;

        // --- Check Reissue Service line: $1,000 per paid reissue request ---
        // ModernTax bills each IRS check-reissue order at PRICE_CHECK_REISSUE
        // ($1,000 via Mercury / $999.99 via Stripe — see lib/pricing.ts).
        // Idempotency: rows carry `billed_at` + `invoice_id` once attached to
        // an invoice, so subsequent cron runs skip them. Eligibility:
        //   - payment_status = 'paid' (customer wired the fee)
        //   - billed_at IS NULL (not yet on any invoice)
        //   - paid_at <= periodEnd (paid in this cycle or earlier; first run
        //     after a paid order will catch earlier-paid rows)
        const checkReissues: Array<{ id: string; entity_name: string | null; tax_year: number; tax_quarter: number; service_fee: number }> = [];
        let checkReissueAmount = 0;
        const { data: paidReissues } = await supabase
          .from('check_reissue_requests')
          .select('id, tax_year, tax_quarter, service_fee, paid_at, request_entities(entity_name)')
          .eq('client_id', client.id)
          .eq('payment_status', 'paid')
          .is('billed_at', null)
          .lte('paid_at', periodEndDate.toISOString()) as { data: any[] | null };
        for (const r of (paidReissues || [])) {
          const fee = typeof r.service_fee === 'number' ? r.service_fee : 1000;
          checkReissues.push({
            id: r.id,
            entity_name: r.request_entities?.entity_name || null,
            tax_year: r.tax_year,
            tax_quarter: r.tax_quarter,
            service_fee: fee,
          });
          checkReissueAmount += fee;
        }
        checkReissueAmount = Math.round(checkReissueAmount * 100) / 100;

        // Skip only for per-TIN clients with zero activity across ALL service
        // lines (verification, monitoring, cash-flow pack, check reissue).
        // Subscription clients always get invoiced for the flat monthly fee.
        if (
          !isSubscription &&
          totalEntities === 0 &&
          monitoringEntities === 0 &&
          cashFlowPacks.length === 0 &&
          checkReissues.length === 0
        ) {
          skipped++;
          continue;
        }

        const grandTotal = Math.round((totalAmount + monitoringAmount + cashFlowAmount + checkReissueAmount) * 100) / 100;

        // Generate invoice number: INV-{year}-{month}-{slug}
        const slugUpper = client.slug.toUpperCase().slice(0, 4);
        const invoiceNumber = `INV-${year}-${String(month).padStart(2, '0')}-${slugUpper}`;

        // Due date = invoice_date (today) + client.billing_net_days (default 5).
        // Invoice date = today (the 1st of the current month).
        const netDays = client.billing_net_days ?? 5;
        const invoiceDate = new Date().toISOString().split('T')[0];
        const dueDateObj = new Date(invoiceDate);
        dueDateObj.setUTCDate(dueDateObj.getUTCDate() + netDays);
        const dueDate = dueDateObj.toISOString().split('T')[0];

        // ---------------------------------------------------------------
        // Insert ModernTax invoice row FIRST (so we have an id to link Mercury to)
        // ---------------------------------------------------------------
        const { data: insertedInvoice, error: insertError } = await supabase
          .from('invoices')
          .insert({
            client_id: client.id,
            invoice_number: invoiceNumber,
            billing_period_start: periodStart,
            billing_period_end: periodEnd,
            total_entities: totalEntities,
            total_amount: grandTotal,
            monitoring_entities: monitoringEntities,
            monitoring_amount: monitoringAmount,
            status: 'draft',
            payment_method: client.billing_payment_method || 'ach',
            due_date: dueDate,
          })
          .select('id')
          .single() as { data: { id: string } | null; error: any };

        if (insertError || !insertedInvoice) {
          console.error(`Failed to create invoice for ${client.name}:`, insertError?.message);
          errors.push({ client: client.name, error: insertError?.message || 'insert failed' });
          continue;
        }

        // Mark check-reissue rows as billed against this invoice. Done after
        // the invoice row exists so the linkage survives partial Mercury
        // failure (same idempotency reasoning as cash-flow packs below).
        if (checkReissues.length > 0) {
          await (supabase.from('check_reissue_requests') as any).update({
            billed_at: new Date().toISOString(),
            invoice_id: insertedInvoice.id,
          }).in('id', checkReissues.map(r => r.id));
        }

        // Mark cash-flow packs as billed against this invoice. Done after the
        // invoice row is in place so the linkage survives a partial Mercury
        // failure (we'd rather have the pack on a draft invoice than risk
        // double-billing on a retry).
        for (const pack of cashFlowPacks) {
          const { data: ent } = await supabase
            .from('request_entities')
            .select('gross_receipts')
            .eq('id', pack.entityId)
            .single() as { data: { gross_receipts: any } | null };
          if (!ent?.gross_receipts?.cash_flow_pack) continue;
          const updated = {
            ...ent.gross_receipts,
            cash_flow_pack: {
              ...ent.gross_receipts.cash_flow_pack,
              billed: true,
              billed_at: new Date().toISOString(),
              invoice_id: insertedInvoice.id,
              invoice_number: invoiceNumber,
            },
          };
          await supabase
            .from('request_entities')
            .update({ gross_receipts: updated })
            .eq('id', pack.entityId);
        }

        // ---------------------------------------------------------------
        // Mercury (ACH) is the BILLING channel for monthly invoices, per
        // Matt's May 2026 split:
        //   • Mercury (ACH)  → monthly usage invoices + $2,500/mo platform fees
        //   • Stripe (card)  → upgrades, in-app add-on purchases, monitoring
        //                       upsells (handled by separate one-off endpoints)
        //
        // The Stripe auto-charge block that lived here (May 2026 v1) was
        // removed because it conflicted with the Mercury-owns-monthly-invoices
        // model. Stripe payment-method-on-file is still required after the
        // free trial — but the saved card is for one-off purchases (cash-flow
        // pack, monitoring enrollment, tier upgrade fees), NOT for the
        // monthly usage rollup.
        // ---------------------------------------------------------------
        if (!process.env.MERCURY_API_KEY) {
          console.warn(`[${client.name}] MERCURY_API_KEY not set — invoice ${invoiceNumber} left as draft`);
          invoicesGenerated++;
          generated.push({ client: client.name, invoiceNumber, totalEntities, totalAmount: grandTotal });
          continue;
        }

        if (!client.billing_ap_email) {
          console.warn(`[${client.name}] billing_ap_email missing — invoice ${invoiceNumber} left as draft`);
          invoicesGenerated++;
          generated.push({ client: client.name, invoiceNumber, totalEntities, totalAmount: grandTotal });
          continue;
        }

        try {
          // Ensure Mercury customer exists, remember id for next cycle.
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
            // Cast — database.types.ts needs regeneration after the Mercury migration.
            await (supabase.from('clients') as any).update({ mercury_customer_id: customer.id }).eq('id', client.id);
          }

          // Build line items.
          //   Subscription clients: one flat subscription line + optional overage line.
          //   Per-TIN clients: one verification line + optional monitoring line.
          const lineItems: { name: string; unitPrice: number; quantity: number }[] = [];
          if (isSubscription) {
            lineItems.push({
              name: `Monthly Subscription — up to ${subIncluded} entities (${periodStart} → ${periodEnd})`,
              unitPrice: subscriptionAmount,
              quantity: 1,
            });
            if (subscriptionOverageEntities > 0) {
              lineItems.push({
                name: `Overage Entities (${totalEntities} total, ${subIncluded} included)`,
                unitPrice: subOverageRate,
                quantity: subscriptionOverageEntities,
              });
            }
          } else {
            // Per-TIN: single line at the client's contracted rate, qty = N.
            // No more averaged unitPrice (which produced misleading numbers
            // like \$68.19 in April when CSV/PDF rates differed). Single
            // baseRate × quantity reads cleanly on the Mercury PDF.
            if (totalEntities > 0) {
              lineItems.push({
                name: `IRS Transcript Verification (${periodStart} → ${periodEnd})`,
                unitPrice: ratePdf,
                quantity: totalEntities,
              });
            }
            if (monitoringEntities > 0) {
              // Monitoring is prorated $/TIN/month so the unit price IS
              // the average per-TIN amount in the period. Mercury display
              // is honest: "N TINs at \$X average".
              lineItems.push({
                name: `Account Monitoring (${periodStart} → ${periodEnd})`,
                unitPrice: monitoringEntities === 0 ? 0 : Math.round((monitoringAmount / monitoringEntities) * 100) / 100,
                quantity: monitoringEntities,
              });
            }
            // Check Reissue Service — one line per paid request so the
            // entity + quarter shows on the Mercury PDF (these are
            // borrower-facing operational data the AP team needs to map
            // back to which check they're being billed for).
            for (const r of checkReissues) {
              const label = r.entity_name
                ? `IRS Check Reissue Service — ${r.entity_name} (Q${r.tax_quarter} ${r.tax_year})`
                : `IRS Check Reissue Service (Q${r.tax_quarter} ${r.tax_year})`;
              lineItems.push({
                name: label,
                unitPrice: r.service_fee,
                quantity: 1,
              });
            }
          }

          const mercuryInvoice = await createMercuryInvoice({
            customerId: mercuryCustomerId!,
            destinationAccountId: getDestinationAccountId(),
            dueDate,
            invoiceDate,
            invoiceNumber,
            lineItems,
            ccEmails: client.billing_ap_email_cc || [],
            creditCardEnabled: false,
            achDebitEnabled: true,
            useRealAccountNumber: false,
            sendEmailOption: 'SendNow',
            servicePeriodStartDate: periodStart,
            servicePeriodEndDate: periodEnd,
            payerMemo: `Reference: ${invoiceNumber}. Net ${netDays} days.`,
            internalNote: `Auto-generated from portal.moderntax.io — ${totalEntities} verification, ${monitoringEntities} monitoring${checkReissues.length > 0 ? `, ${checkReissues.length} check-reissue` : ''}.`,
          });

          // Update our invoice row with Mercury ids + mark as sent.
          await supabase.from('invoices').update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            mercury_reference: mercuryInvoice.invoiceNumber,
            mercury_invoice_id: mercuryInvoice.id,
            mercury_invoice_slug: mercuryInvoice.slug,
            mercury_pay_url: getMercuryPayUrl(mercuryInvoice.slug),
            mercury_pdf_url: getMercuryInvoicePdfUrl(mercuryInvoice.slug),
          }).eq('id', insertedInvoice.id);

          console.log(`[${client.name}] Mercury invoice ${mercuryInvoice.id} sent to ${client.billing_ap_email} ($${grandTotal})`);

          // Auto-send the itemized breakdown PDF to AP recipients exactly
          // ONCE per invoice (Matt 2026-05-04: future dunning reminders for
          // unpaid invoices skip the breakdown — just send the payment
          // nudge). The breakdown_sent_at column is the idempotence guard.
          await sendBreakdownOnce(insertedInvoice.id, client.name);
        } catch (mercuryErr) {
          const msg = mercuryErr instanceof Error ? mercuryErr.message : 'Mercury error';
          console.error(`[${client.name}] Mercury invoice creation failed: ${msg}`);
          errors.push({ client: client.name, error: `mercury: ${msg}` });
          // Leave ModernTax row in 'draft' — admin can retry.
        }

        invoicesGenerated++;
        generated.push({
          client: client.name,
          invoiceNumber,
          totalEntities,
          totalAmount: grandTotal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Error processing client ${client.name}:`, msg);
        errors.push({ client: client.name, error: msg });
      }
    }

    return NextResponse.json({
      success: true,
      billingPeriod: { year, month, periodStart, periodEnd },
      invoicesGenerated,
      clientsProcessed,
      skipped,
      generated,
      processedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Auto-invoice cron error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Cron job failed', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Fire the itemized breakdown PDF to AP recipients exactly once per invoice.
 * Idempotent via `invoices.breakdown_sent_at` — second invocation no-ops.
 * Non-blocking: any send failure is logged but doesn't fail the surrounding
 * invoice creation (the Mercury invoice is already in the customer's inbox).
 */
async function sendBreakdownOnce(invoiceId: string, clientName: string): Promise<void> {
  const supabase = createAdminClient();
  // Atomic-ish check: if breakdown_sent_at is already set, skip. Race window
  // is tiny (single cron, single thread per invoice) and the worst case is
  // one duplicate send — acceptable.
  const { data: row } = await (supabase.from('invoices') as any)
    .select('breakdown_sent_at')
    .eq('id', invoiceId)
    .single();
  if (row?.breakdown_sent_at) {
    console.log(`[${clientName}] breakdown already sent (${row.breakdown_sent_at}), skipping`);
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
      console.error(`[${clientName}] breakdown send failed (${res.status}): ${body.slice(0, 200)}`);
      return;
    }
    await (supabase.from('invoices') as any)
      .update({ breakdown_sent_at: new Date().toISOString() })
      .eq('id', invoiceId);
    console.log(`[${clientName}] breakdown PDF sent + stamped`);
  } catch (err) {
    console.error(`[${clientName}] breakdown send threw:`, err instanceof Error ? err.message : err);
  }
}
