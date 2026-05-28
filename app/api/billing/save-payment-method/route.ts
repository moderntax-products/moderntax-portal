/**
 * POST /api/billing/save-payment-method
 *
 * Called by the /payment-method page AFTER Stripe Elements successfully
 * confirms a SetupIntent. Body carries the payment_method_id; we hydrate
 * the brand/last4/type from Stripe and persist them to clients.
 *
 * Also sets the payment method as the customer's invoice_settings default
 * so future Stripe-issued invoices auto-charge it.
 *
 * Auth: manager or admin (own client only).
 *
 * Body: { paymentMethodId: string }
 *
 * Response: { success: true, label: string, last4: string, brand: string, type: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe, formatPaymentMethodLabel } from '@/lib/stripe';
import { logAuditFromRequest } from '@/lib/audit';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null };

    if (!profile || !['admin', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Manager or admin only' }, { status: 403 });
    }
    if (!profile.client_id) {
      return NextResponse.json({ error: 'No client on profile' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const paymentMethodId = typeof body?.paymentMethodId === 'string' ? body.paymentMethodId : null;
    if (!paymentMethodId || !paymentMethodId.startsWith('pm_')) {
      return NextResponse.json({ error: 'paymentMethodId required' }, { status: 400 });
    }

    const { data: client } = await admin
      .from('clients')
      .select('id, name, stripe_customer_id')
      .eq('id', profile.client_id)
      .single() as { data: any };

    if (!client?.stripe_customer_id) {
      return NextResponse.json({ error: 'No Stripe customer — call setup-intent first' }, { status: 400 });
    }

    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    // Verify the payment method belongs to this customer (else we're saving
    // a method that isn't attached and can't be charged).
    if (pm.customer && pm.customer !== client.stripe_customer_id) {
      return NextResponse.json(
        { error: 'Payment method belongs to a different Stripe customer' },
        { status: 400 },
      );
    }

    // Set as the invoice default — Stripe will use this for any future
    // PaymentIntents we create with the customer.
    await stripe.customers.update(client.stripe_customer_id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Extract human-readable details depending on type.
    const type = pm.type; // 'card' | 'us_bank_account' | etc.
    let brand: string | null = null;
    let last4: string | null = null;
    if (type === 'card' && pm.card) {
      brand = pm.card.brand;
      last4 = pm.card.last4;
    } else if (type === 'us_bank_account' && pm.us_bank_account) {
      brand = pm.us_bank_account.bank_name || null;
      last4 = pm.us_bank_account.last4 || null;
    }

    const update = {
      stripe_payment_method_id: paymentMethodId,
      payment_method_type: type,
      payment_method_brand: brand,
      payment_method_last4: last4,
      payment_method_attached_at: new Date().toISOString(),
      payment_method_status: 'active',
    };

    const { error: upErr } = await (admin
      .from('clients') as any)
      .update(update)
      .eq('id', profile.client_id);
    if (upErr) {
      console.error('[save-payment-method] DB update failed:', upErr);
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    await logAuditFromRequest(admin, request, {
      action: 'settings_changed',
      userId: user.id,
      userEmail: user.email || '',
      resourceType: 'client',
      resourceId: profile.client_id,
      details: {
        setting: 'payment_method_attached',
        scope: 'stripe',
        payment_method_id: paymentMethodId,
        type,
        brand,
        last4,
      },
    });

    return NextResponse.json({
      success: true,
      label: formatPaymentMethodLabel({ payment_method_type: type, payment_method_brand: brand, payment_method_last4: last4 }),
      type,
      brand,
      last4,
    });
  } catch (err) {
    console.error('[save-payment-method] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
