/**
 * POST /api/billing/self-serve-checkout
 *
 * NO-AUTH endpoint — anyone landing on /sample-transcripts/erc-report
 * can click "Buy 3-pack ERC pulls" and go straight to Stripe Checkout
 * without first creating a portal account. Stripe collects the customer
 * email at the payment step; the webhook then notifies matt@moderntax.io
 * to onboard them off-platform within 24 hours.
 *
 * Body: { pack: SelfServePackId }
 *   pack must be a key from lib/pricing.SELF_SERVE_CATALOG.
 *
 * Response: { url: string, sessionId: string }
 *   Client redirects via window.location.href = url.
 *
 * Security note: this is intentionally unauthenticated, but the SKU set
 * is server-side and immutable per request. A malicious caller can't
 * inject an arbitrary price — the catalog lookup gates that. The worst
 * thing they can do is create extra abandoned Checkout Sessions, which
 * Stripe expires after 24 hours.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { SELF_SERVE_CATALOG, type SelfServePackId } from '@/lib/pricing';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { pack?: string } | null;
    const packId = body?.pack as SelfServePackId | undefined;

    if (!packId || !(packId in SELF_SERVE_CATALOG)) {
      return NextResponse.json(
        { error: 'Invalid pack', available: Object.keys(SELF_SERVE_CATALOG) },
        { status: 400 },
      );
    }

    const item = SELF_SERVE_CATALOG[packId];
    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    // No customer pre-existing — let Stripe create one based on the email
    // entered during checkout. The webhook reads the new customer's email
    // from the completed session and uses it to email Matt for onboarding.
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      // customer_creation: 'always' guarantees Stripe persists the customer
      // record (so the webhook + future invoices have something to attach
      // the new client_id to once Matt onboards them).
      customer_creation: 'always',
      // billing_address_collection: 'required' captures the company name +
      // address that Matt needs to set up the clients row.
      billing_address_collection: 'required',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(item.price * 100),
          product_data: {
            name: item.name,
            description: item.description,
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/sample-transcripts/erc-report?cancel=1`,
      metadata: {
        flow: 'self_serve',
        pack: packId,
        pack_name: item.name,
        pack_quantity: String(item.quantity),
      },
      custom_text: {
        submit: {
          message: 'After payment we\'ll email you within 1 business day to confirm onboarding details + the EINs you want pulled. First report typically delivered within 24 hours of receiving your 8821s.',
        },
      },
    });

    if (!checkout.url) {
      return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
    }

    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
      pack: packId,
      amount: item.price,
    });
  } catch (err) {
    console.error('[billing/self-serve-checkout] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
