/**
 * Billing Settings API
 * PATCH /api/billing/settings — Manager updates their client's billing preferences
 * GET /api/billing/settings — Get current billing settings
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerComponentClient } from '@/lib/supabase-server';

export async function GET() {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['manager', 'admin'].includes(profile.role) || !profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: client, error } = await supabase
      .from('clients')
      .select('billing_payment_method, billing_ap_email, billing_ap_phone, billing_rate_pdf, billing_rate_csv')
      .eq('id', profile.client_id)
      .single();

    if (error) return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });

    return NextResponse.json({ settings: client });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createServerComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null; error: any };

    if (!profile || !['manager', 'admin'].includes(profile.role) || !profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { billing_payment_method, billing_ap_email, billing_ap_phone } = body;

    // Validate payment method
    if (billing_payment_method && !['ach', 'wire'].includes(billing_payment_method)) {
      return NextResponse.json({ error: 'Invalid payment method. Must be "ach" or "wire".' }, { status: 400 });
    }

    const updateData: Record<string, any> = {};
    if (billing_payment_method !== undefined) updateData.billing_payment_method = billing_payment_method;
    if (billing_ap_email !== undefined) updateData.billing_ap_email = billing_ap_email;
    if (billing_ap_phone !== undefined) updateData.billing_ap_phone = billing_ap_phone;

    const { error } = await supabase
      .from('clients')
      .update(updateData)
      .eq('id', profile.client_id);

    if (error) return NextResponse.json({ error: 'Failed to update settings', details: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
