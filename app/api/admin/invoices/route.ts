/**
 * Admin Invoices API
 * POST /api/admin/invoices — Generate invoice for a client/month
 * GET /api/admin/invoices — List all invoices (with optional client filter)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const clientId = request.nextUrl.searchParams.get('client_id');
    const admin = createAdminClient();

    let query = admin
      .from('invoices')
      .select('*, clients(name, slug)')
      .order('billing_period_start', { ascending: false });

    if (clientId) {
      query = query.eq('client_id', clientId);
    }

    const { data: invoices, error } = await query;

    if (error) return NextResponse.json({ error: 'Failed to fetch invoices', details: error.message }, { status: 500 });

    return NextResponse.json({ invoices });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: any };

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { client_id, year, month } = body;

    if (!client_id || !year || !month) {
      return NextResponse.json({ error: 'client_id, year, and month are required' }, { status: 400 });
    }

    const admin = createAdminClient();

    // Get client info
    const { data: client } = await admin
      .from('clients')
      .select('name, slug, free_trial, billing_payment_method, billing_rate_pdf, billing_rate_csv')
      .eq('id', client_id)
      .single() as { data: { name: string; slug: string; free_trial: boolean; billing_payment_method: string | null; billing_rate_pdf: number; billing_rate_csv: number } | null; error: any };

    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

    // Calculate billing period
    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const periodEnd = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month

    // Check for existing invoice
    const { data: existing } = await admin
      .from('invoices')
      .select('id')
      .eq('client_id', client_id)
      .eq('billing_period_start', periodStart)
      .eq('billing_period_end', periodEnd)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Invoice already exists for this period', invoice_id: existing.id }, { status: 409 });
    }

    // Get all completed entities for this client in this billing period
    const { data: completedRequests } = await admin
      .from('requests')
      .select('id, intake_method, request_entities(id, status, completed_at)')
      .eq('client_id', client_id) as { data: any[] | null; error: any };

    // Filter to entities completed in the billing period
    const periodStartDate = new Date(periodStart);
    const periodEndDate = new Date(periodEnd + 'T23:59:59.999Z');

    let totalEntities = 0;
    let totalAmount = 0;
    const ratePdf = client.billing_rate_pdf || 59.98;
    const rateCsv = client.billing_rate_csv || 69.98;

    // If free trial, get the first 3 entities across all time to exclude them
    let freeEntityIds = new Set<string>();
    if (client.free_trial) {
      const allEntities = (completedRequests || [])
        .flatMap((r: any) => (r.request_entities || []).map((e: any) => ({
          ...e,
          intake_method: r.intake_method,
          request_id: r.id,
        })))
        .filter((e: any) => e.status !== 'failed')
        .sort((a: any, b: any) => new Date(a.completed_at || '9999').getTime() - new Date(b.completed_at || '9999').getTime());
      freeEntityIds = new Set(allEntities.slice(0, 3).map((e: any) => e.id));
    }

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

    // Generate invoice number
    const slugUpper = client.slug.toUpperCase().slice(0, 4);
    const invoiceNumber = `INV-${year}-${String(month).padStart(2, '0')}-${slugUpper}`;

    // Due date: 30 days after end of billing period
    const dueDate = new Date(periodEndDate);
    dueDate.setDate(dueDate.getDate() + 30);

    const { data: invoice, error: insertError } = await admin
      .from('invoices')
      .insert({
        client_id,
        invoice_number: invoiceNumber,
        billing_period_start: periodStart,
        billing_period_end: periodEnd,
        total_entities: totalEntities,
        total_amount: totalAmount,
        status: 'draft',
        payment_method: client.billing_payment_method,
        due_date: dueDate.toISOString().split('T')[0],
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json({ error: 'Failed to create invoice', details: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ invoice }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
