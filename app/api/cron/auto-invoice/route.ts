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

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    // Validate CRON_SECRET
    const cronSecret = request.headers.get('Authorization');
    const expectedSecret = process.env.CRON_SECRET;

    if (!cronSecret || !expectedSecret || cronSecret !== `Bearer ${expectedSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid CRON_SECRET' },
        { status: 401 }
      );
    }

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

    // Get all clients (including Mercury integration fields)
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select(
        'id, name, slug, free_trial, billing_payment_method, billing_rate_pdf, billing_rate_csv, ' +
        'billing_rate_monitoring, billing_net_days, billing_ap_email, ' +
        'billing_model, subscription_monthly_amount, subscription_included_entities, subscription_overage_rate, ' +
        'billing_effective_from, billing_notes, ' +
        'mercury_customer_id, ' +
        'address_line1, address_line2, address_city, address_state, address_postal_code, address_country'
      ) as {
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
          // Per-TIN: sum rates for each completed entity in the period
          (completedRequests || []).forEach((req: any) => {
            const entities = req.request_entities || [];
            entities.forEach((entity: any) => {
              if (entity.status !== 'completed' || !entity.completed_at) return;
              const completedDate = new Date(entity.completed_at);
              if (completedDate < billableStart || completedDate > periodEndDate) return;
              if (freeEntityIds.has(entity.id)) return;

              totalEntities += 1;
              const rate = req.intake_method === 'csv' ? rateCsv : ratePdf;
              totalAmount += rate;
            });
          });
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

        // Skip only for per-TIN clients with zero activity. Subscription
        // clients always get invoiced for the flat monthly fee.
        if (!isSubscription && totalEntities === 0 && monitoringEntities === 0) {
          skipped++;
          continue;
        }

        const grandTotal = Math.round((totalAmount + monitoringAmount) * 100) / 100;

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

        // ---------------------------------------------------------------
        // Mercury: find-or-create customer + create invoice (emailed immediately)
        // If MERCURY_API_KEY is missing OR customer provisioning fails, leave
        // the invoice in draft so admin can retry manually.
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
            if (totalEntities > 0) {
              lineItems.push({
                name: `IRS Transcript Verification (${periodStart} → ${periodEnd})`,
                unitPrice: totalEntities === 0 ? 0 : Math.round((totalAmount / totalEntities) * 100) / 100,
                quantity: totalEntities,
              });
            }
            if (monitoringEntities > 0) {
              lineItems.push({
                name: `Account Monitoring (${periodStart} → ${periodEnd})`,
                unitPrice: monitoringEntities === 0 ? 0 : Math.round((monitoringAmount / monitoringEntities) * 100) / 100,
                quantity: monitoringEntities,
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
            ccEmails: [],
            creditCardEnabled: false,
            achDebitEnabled: true,
            useRealAccountNumber: false,
            sendEmailOption: 'SendNow',
            servicePeriodStartDate: periodStart,
            servicePeriodEndDate: periodEnd,
            payerMemo: `Reference: ${invoiceNumber}. Net ${netDays} days.`,
            internalNote: `Auto-generated from portal.moderntax.io — ${totalEntities} verification, ${monitoringEntities} monitoring.`,
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
