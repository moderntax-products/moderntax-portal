/**
 * POST /api/billing/checkout-session
 *
 * Create a Stripe Checkout Session in `mode=setup` to collect a card via
 * Stripe's hosted page. Returns the session URL; the frontend redirects.
 *
 * Why hosted Checkout instead of inline Elements:
 *   - Inline PaymentElement requires the SetupIntent's payment_method_types
 *     to match what's configured on the Stripe account. With ACH enabled
 *     (default for most accounts) but Financial Connections NOT configured,
 *     PaymentElement silently stalls trying to render the bank-account tab.
 *   - Stripe Checkout handles this server-side and only renders payment
 *     methods that are actually usable.
 *   - Per Matt's billing split (May 2026): Stripe = card-only for upgrades
 *     and add-ons; Mercury = ACH for monthly invoices. Hosted Checkout is
 *     the cleanest implementation of "card-only Stripe" without breaking
 *     anyone's current ACH flow.
 *
 * Auth: manager (own client) or admin (passes ?clientId or uses profile.client_id).
 *
 * Body: { clientId?: string }   // admin override only
 *
 * Response:
 *   { url: string, sessionId: string, customerId: string }
 *
 * On success, the user clicks the URL → enters card on Stripe → returns to
 *   /payment-method?status=success&session_id=cs_xxx
 * On cancel:
 *   /payment-method?status=cancel
 *
 * Stripe webhook (`checkout.session.completed`) does the actual save of the
 * payment method to clients table — see app/api/webhook/stripe/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe, findOrCreateStripeCustomer } from '@/lib/stripe';

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

    // Same admin clientId-override pattern as /api/billing/setup-intent.
    const body = await request.json().catch(() => ({} as any));
    const requestedClientId = typeof body?.clientId === 'string' ? body.clientId : null;
    const effectiveClientId = profile.role === 'admin'
      ? (requestedClientId || profile.client_id)
      : profile.client_id;
    if (!effectiveClientId) {
      return NextResponse.json(
        { error: 'No client to attach a payment method to. Pass { clientId } as admin.' },
        { status: 400 },
      );
    }

    const { data: client, error: clientErr } = await admin
      .from('clients')
      .select('id, name, stripe_customer_id, billing_ap_email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
      .eq('id', effectiveClientId)
      .single() as { data: any; error: any };

    if (clientErr) {
      console.error('[checkout-session] client query failed:', clientErr);
      return NextResponse.json({ error: `Client lookup failed: ${clientErr.message}` }, { status: 500 });
    }
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

    const customerId = await findOrCreateStripeCustomer(client, admin);

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
    const stripe = getStripe();

    // mode='setup' creates a SetupIntent under the hood that captures the card
    // for future off_session use. payment_method_types: ['card'] is the
    // explicit "card only — Mercury handles ACH" enforcement.
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      // success_url MUST contain {CHECKOUT_SESSION_ID} for the return flow
      // to know which session to confirm (we use it to display "Visa ending in
      // 4242" immediately, before the webhook lands).
      success_url: `${baseUrl}/payment-method?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment-method?status=cancel`,
      metadata: {
        moderntax_client_id: effectiveClientId,
        moderntax_user_id: user.id,
      },
      // Show what they're saving the card for (renders on the Stripe page).
      custom_text: {
        submit: {
          message: 'Authorizing this card lets ModernTax charge it for tier upgrades, add-on purchases (cash-flow pack, monitoring), and other in-app one-time charges. Monthly usage invoices are billed separately via Mercury (ACH).',
        },
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL' }, { status: 500 });
    }

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
      customerId,
    });
  } catch (err) {
    console.error('[checkout-session] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
