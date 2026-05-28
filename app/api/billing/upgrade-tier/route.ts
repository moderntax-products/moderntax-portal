/**
 * POST /api/billing/upgrade-tier
 *
 * In-app self-serve tier upgrade via Stripe Checkout. Replaces the
 * "Talk to sales" mailto path that previously routed every upgrade
 * through matt@moderntax.io.
 *
 * Tier B (Deposit):
 *   - One-time $2,500 prepaid deposit (mode=payment).
 *   - On webhook success: client.billing_model='per_tin',
 *     billing_rate_pdf=$59.98, billing_rate_csv=$59.98,
 *     billing_effective_from=today.
 *
 * Tier C (Platform):
 *   - $2,500/month subscription (mode=subscription).
 *   - On webhook success: billing_model='subscription',
 *     subscription_monthly_amount=2500,
 *     subscription_included_entities=50, subscription_overage_rate=39.99,
 *     billing_rate_pdf=39.99 (overage rate, used by per-TIN paths).
 *
 * Auth: manager or admin. Admin can pass clientId to upgrade any client;
 * manager is pinned to their own.
 *
 * Body: { tier: 'B' | 'C', clientId?: string }
 *
 * Response: { url: string, sessionId: string }
 *   The frontend redirects to `url` (Stripe Checkout). On success, Stripe
 *   redirects back to /plans?upgrade=success&tier=...&session_id=...
 *
 * Webhook: see app/api/webhook/stripe/route.ts handler for
 * `checkout.session.completed` with mode in (payment, subscription) and
 * metadata.flow='tier_upgrade'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe, findOrCreateStripeCustomer } from '@/lib/stripe';

// Pricing constants — mirrored on /plans + UpgradeYourTeamPanel. Single
// source of truth for the actual Checkout creation lives here.
const TIER_B_DEPOSIT_USD = 2500;
const TIER_B_RATE = 59.98;
const TIER_C_MONTHLY_USD = 2500;
const TIER_C_INCLUDED_ENTITIES = 50;
const TIER_C_OVERAGE_RATE = 39.99;

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

    const body = await request.json().catch(() => ({} as any));
    const tier = body?.tier;
    if (tier !== 'B' && tier !== 'C') {
      return NextResponse.json({ error: 'tier must be "B" or "C"' }, { status: 400 });
    }
    const requestedClientId = typeof body?.clientId === 'string' ? body.clientId : null;
    const effectiveClientId = profile.role === 'admin'
      ? (requestedClientId || profile.client_id)
      : profile.client_id;
    if (!effectiveClientId) {
      return NextResponse.json({ error: 'No client to upgrade' }, { status: 400 });
    }

    const { data: client, error: cErr } = await admin
      .from('clients')
      .select('id, name, stripe_customer_id, billing_ap_email, billing_model, address_line1, address_line2, address_city, address_state, address_postal_code, address_country')
      .eq('id', effectiveClientId)
      .single() as { data: any; error: any };
    if (cErr) return NextResponse.json({ error: `Client lookup failed: ${cErr.message}` }, { status: 500 });
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

    const customerId = await findOrCreateStripeCustomer(client, admin);
    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    if (tier === 'B') {
      // One-time deposit. Uses inline price_data so no pre-configured Stripe
      // Price ID is required — keeps the upgrade self-contained.
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: TIER_B_DEPOSIT_USD * 100,
            product_data: {
              name: 'ModernTax — Tier B (Deposit) onboarding',
              description: `${client.name} — $2,500 prepaid deposit. Locks per-TIN rate at $${TIER_B_RATE.toFixed(2)} for the next 12 months. Each verification draws against this balance until exhausted.`,
            },
          },
          quantity: 1,
        }],
        success_url: `${baseUrl}/plans?upgrade=success&tier=B&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/plans?upgrade=cancel`,
        metadata: {
          flow: 'tier_upgrade',
          target_tier: 'B',
          moderntax_client_id: effectiveClientId,
          moderntax_user_id: user.id,
        },
        custom_text: {
          terms_of_service_acceptance: {
            message: 'By paying you accept the [ModernTax MSA Tier B](https://moderntax.io/msa).',
          },
          submit: {
            message: 'After payment, your team\'s rate locks at $59.98/verified entity for 12 months. Deposit is refundable on unused balance per MSA.',
          },
        },
        consent_collection: { terms_of_service: 'required' },
      });
      if (!session.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
      return NextResponse.json({ url: session.url, sessionId: session.id, tier: 'B' });
    }

    // Tier C — recurring subscription
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: TIER_C_MONTHLY_USD * 100,
          recurring: { interval: 'month' },
          product_data: {
            name: 'ModernTax — Tier C (Platform)',
            description: `${client.name} — $2,500/mo platform subscription. Includes ${TIER_C_INCLUDED_ENTITIES} verifications/mo + REST API + webhook delivery + white-label borrower doc hub. Overage at $${TIER_C_OVERAGE_RATE.toFixed(2)}/entity.`,
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/plans?upgrade=success&tier=C&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/plans?upgrade=cancel`,
      metadata: {
        flow: 'tier_upgrade',
        target_tier: 'C',
        moderntax_client_id: effectiveClientId,
        moderntax_user_id: user.id,
      },
      subscription_data: {
        metadata: {
          flow: 'tier_upgrade',
          target_tier: 'C',
          moderntax_client_id: effectiveClientId,
        },
        description: `Tier C Platform subscription for ${client.name}`,
      },
      custom_text: {
        terms_of_service_acceptance: {
          message: 'By subscribing you accept the [ModernTax MSA Tier C](https://moderntax.io/msa). Cancel any time from the portal.',
        },
      },
      consent_collection: { terms_of_service: 'required' },
    });
    if (!session.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
    return NextResponse.json({ url: session.url, sessionId: session.id, tier: 'C' });
  } catch (err) {
    console.error('[upgrade-tier] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
