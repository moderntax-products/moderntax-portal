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

    // Get all clients
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('id, name, slug, free_trial, billing_payment_method, billing_rate_pdf, billing_rate_csv') as {
        data: {
          id: string;
          name: string;
          slug: string;
          free_trial: boolean;
          billing_payment_method: string | null;
          billing_rate_pdf: number;
          billing_rate_csv: number;
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

        // Calculate billable entities in the billing period
        let totalEntities = 0;
        let totalAmount = 0;

        (completedRequests || []).forEach((req: any) => {
          const entities = req.request_entities || [];
          entities.forEach((entity: any) => {
            if (entity.status !== 'completed' || !entity.completed_at) return;
            const completedDate = new Date(entity.completed_at);
            if (completedDate < periodStartDate || completedDate > periodEndDate) return;
            if (freeEntityIds.has(entity.id)) return;

            totalEntities += 1;
            const rate = req.intake_method === 'csv' ? rateCsv : ratePdf;
            totalAmount += rate;
          });
        });

        // Skip if zero billable entities
        if (totalEntities === 0) {
          skipped++;
          continue;
        }

        // Generate invoice number: INV-{year}-{month}-{slug}
        const slugUpper = client.slug.toUpperCase().slice(0, 4);
        const invoiceNumber = `INV-${year}-${String(month).padStart(2, '0')}-${slugUpper}`;

        // Due date: 30 days after end of billing period
        const dueDate = new Date(periodEndDate);
        dueDate.setDate(dueDate.getDate() + 30);

        const { error: insertError } = await supabase
          .from('invoices')
          .insert({
            client_id: client.id,
            invoice_number: invoiceNumber,
            billing_period_start: periodStart,
            billing_period_end: periodEnd,
            total_entities: totalEntities,
            total_amount: totalAmount,
            status: 'draft',
            payment_method: client.billing_payment_method,
            due_date: dueDate.toISOString().split('T')[0],
          });

        if (insertError) {
          console.error(`Failed to create invoice for ${client.name}:`, insertError.message);
          errors.push({ client: client.name, error: insertError.message });
          continue;
        }

        invoicesGenerated++;
        generated.push({
          client: client.name,
          invoiceNumber,
          totalEntities,
          totalAmount,
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
