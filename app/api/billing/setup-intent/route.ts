/**
 * POST /api/billing/setup-intent
 *
 * Create a Stripe SetupIntent for saving a payment method (no charge — just
 * collecting + verifying the method for future off_session use). Returns the
 * client_secret that Stripe Elements uses on the frontend to confirm.
 *
 * Auth: manager or admin. Creates/reuses a Stripe Customer keyed to the
 * caller's clients.id.
 *
 * Body: none (caller's profile.client_id is the source of truth).
 *
 * Response:
 *   { clientSecret: string, customerId: string, publishableKey: string }
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

    // Admins can target any client by passing { clientId } in the body — useful
    // for testing payment flows from the master account (matt@moderntax.io has
    // no client_id on his admin profile, so without the override he could
    // never use this page). Managers are pinned to their own client_id.
    const body = await request.json().catch(() => ({} as any));
    const requestedClientId = typeof body?.clientId === 'string' ? body.clientId : null;
    const effectiveClientId = profile.role === 'admin'
      ? (requestedClientId || profile.client_id)
      : profile.client_id;
    if (!effectiveClientId) {
      return NextResponse.json(
        { error: profile.role === 'admin'
            ? 'Admin: pass { clientId } in the request body, OR set client_id on your profile.'
            : 'No client on profile' },
        { status: 400 },
      );
    }

    // Pull the client row — needed both for the Stripe customer creation and
    // for the response payload (so the UI can show the lender name on the form).
    // NOTE: address columns use the address_* prefix everywhere in the schema
    // (address_city / address_state / address_postal_code) — NOT city/state/zip_code.
    // Surfacing the Supabase error explicitly catches column-name typos that
    // would otherwise silently return null and read as "client not found."
    const { data: client, error: clientErr } = await admin
      .from('clients')
      .select('id, name, stripe_customer_id, billing_ap_email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
      .eq('id', effectiveClientId)
      .single() as { data: any; error: any };

    if (clientErr) {
      console.error('[setup-intent] client query failed:', clientErr);
      return NextResponse.json({ error: `Client lookup failed: ${clientErr.message}` }, { status: 500 });
    }
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

    const customerId = await findOrCreateStripeCustomer(client, admin);

    const stripe = getStripe();
    // SetupIntent creation — uses Stripe's `automatic_payment_methods` (the
    // current recommended pattern, replacing the older `payment_method_types`
    // array). With `allow_redirects: 'never'` we exclude redirect-based
    // methods (Klarna, Affirm) and keep only card on this account today.
    //
    // Per Matt's billing split (May 2026):
    //   • Stripe (card) → upgrades, add-on purchases (cash-flow pack,
    //     monitoring upsells), in-app one-time charges
    //   • Mercury (ACH) → monthly usage invoices + $2,500/mo platform fees
    //
    // ACH-via-Stripe is intentionally OFF — Mercury owns the ACH path.
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
      usage: 'off_session',
      metadata: { moderntax_client_id: effectiveClientId },
    });

    if (!setupIntent.client_secret) {
      return NextResponse.json({ error: 'Stripe did not return a client_secret' }, { status: 500 });
    }

    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
    if (!publishableKey) {
      return NextResponse.json({ error: 'Stripe publishable key not configured' }, { status: 500 });
    }

    return NextResponse.json({
      clientSecret: setupIntent.client_secret,
      customerId,
      publishableKey,
      clientName: client.name,
    });
  } catch (err) {
    console.error('[setup-intent] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
