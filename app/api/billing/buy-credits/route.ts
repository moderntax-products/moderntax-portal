/**
 * POST /api/billing/buy-credits
 *
 * Manager/admin buys a prepaid credit pack ($1,000 → 40% off, $2,000 → 60% off).
 * Returns a Stripe Checkout URL. On payment, the Stripe webhook credits the
 * client's wallet (credit_balance) and locks in the discounted per-request rate.
 *
 * Body: { pack: 'credits-1000' | 'credits-2000' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe, findOrCreateStripeCustomer } from '@/lib/stripe';
import { getCreditPack } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as { data: { role: string; client_id: string | null } | null };
    if (!profile || !['manager', 'admin', 'processor'].includes(profile.role) || !profile.client_id) {
      return NextResponse.json({ error: 'Only a client manager can buy credits' }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as { pack?: string } | null;
    const pack = getCreditPack(body?.pack || '');
    if (!pack) {
      return NextResponse.json({ error: 'Invalid pack', available: ['credits-1000', 'credits-2000'] }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: client } = await admin.from('clients')
      .select('id, name, stripe_customer_id, billing_ap_email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
      .eq('id', profile.client_id).single() as { data: any };
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

    const customerId = await findOrCreateStripeCustomer(client, admin);
    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer: customerId,
      // Save the card for future top-ups + as the required card-on-file.
      payment_intent_data: { setup_future_usage: 'off_session' },
      // Reference the real Stripe catalog Price (SKU) — clean reporting +
      // product-level analytics, and price changes don't need a code deploy.
      line_items: [{ price: pack.stripePriceId, quantity: 1 }],
      success_url: `${baseUrl}/invoicing?credits=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/invoicing?credits=cancel`,
      metadata: {
        flow: 'credit_purchase',
        client_id: client.id,
        pack: pack.id,
        pack_amount: String(pack.amount),
        pack_rate: String(pack.ratePerRequest),
      },
    });

    if (!checkout.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
    return NextResponse.json({ url: checkout.url, sessionId: checkout.id, pack: pack.id, amount: pack.amount });
  } catch (err) {
    console.error('[billing/buy-credits] error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
  }
}
