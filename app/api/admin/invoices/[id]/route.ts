/**
 * Admin Invoice Update API
 * PATCH /api/admin/invoices/[id] — Update invoice status, mark as sent/paid, add Mercury reference
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient, createAdminClient } from '@/lib/supabase-server';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
    const admin = createAdminClient();

    const updateData: Record<string, any> = {};

    if (body.status) {
      if (!['draft', 'sent', 'paid', 'overdue'].includes(body.status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updateData.status = body.status;

      if (body.status === 'sent') {
        updateData.sent_at = new Date().toISOString();
      }
      if (body.status === 'paid') {
        updateData.paid_at = new Date().toISOString();
      }
    }

    if (body.mercury_reference !== undefined) updateData.mercury_reference = body.mercury_reference;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.payment_method !== undefined) updateData.payment_method = body.payment_method;
    if (body.due_date !== undefined) updateData.due_date = body.due_date;

    const { data: invoice, error } = await admin
      .from('invoices')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to update invoice', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ invoice });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
