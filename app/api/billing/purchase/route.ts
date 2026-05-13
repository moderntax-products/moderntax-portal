/**
 * POST /api/billing/purchase
 *
 * Unified one-time-payment endpoint for in-app premium services. Creates
 * a Stripe Checkout Session in `mode=payment`, returns the URL, and
 * stores the session id on the underlying record so the webhook can mark
 * it paid when the customer completes.
 *
 * Supported flows (the `kind` discriminator in the request body):
 *
 *   1. kind=check_reissue → DISABLED — billing moved to Mercury ACH.
 *      The client-side `RequestCheckReissueButton` no longer hits this
 *      endpoint; it just records the row via /api/admin/check-reissue
 *      which then emails Matt to send a Mercury invoice. Kept here as
 *      a 410 Gone so any in-flight client code surfaces a clear error
 *      instead of silently creating a Stripe session.
 *
 *   2. kind=erc_full_sweep
 *      Body: { kind: 'erc_full_sweep', entity_id: <uuid> }
 *      Charges PRICE_ERC_FULL_SWEEP_PREMIUM ($79.98) on a 941 entity,
 *      stores erc_full_sweep_session_id on the entity. Webhook flips
 *      erc_full_sweep_paid=true so the expert pulls all eligible
 *      quarters instead of the base 3.
 *
 * Response: { url: string, sessionId: string }
 * Client redirects window.location.href = url.
 *
 * Auth: admin only (managers/processors don't initiate these — they're
 * always admin-triggered actions from the ERC report page).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe, findOrCreateStripeCustomer } from '@/lib/stripe';
import { PRICE_ERC_FULL_SWEEP_PREMIUM } from '@/lib/pricing';
// Note: PRICE_CHECK_REISSUE was removed — check-reissue is now billed via
// Mercury ACH (see the kind='check_reissue' branch below) and no longer
// touches Stripe from this endpoint.

interface BaseBody {
  kind: 'check_reissue' | 'erc_full_sweep';
}
interface CheckReissueBody extends BaseBody {
  kind: 'check_reissue';
  check_reissue_id: string;
}
interface ErcFullSweepBody extends BaseBody {
  kind: 'erc_full_sweep';
  entity_id: string;
}
type PurchaseBody = CheckReissueBody | ErcFullSweepBody;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sessionClient = createServerRouteClient(cookieStore);
    const { data: { user } } = await sessionClient.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('role, client_id')
      .eq('id', user.id)
      .single() as { data: { role: string; client_id: string | null } | null };
    if (!profile) {
      return NextResponse.json({ error: 'No profile' }, { status: 403 });
    }
    // Admins can purchase for any client. Managers / processors can only
    // purchase for entities/reissues that belong to their own client. We
    // resolve the target client_id from the body after parsing and verify
    // it matches profile.client_id for non-admins.
    const isAdmin = profile.role === 'admin';
    const allowedClientRoles = ['manager', 'processor', 'team_member'];
    if (!isAdmin && !allowedClientRoles.includes(profile.role)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as PurchaseBody | null;
    if (!body || !body.kind) {
      return NextResponse.json({ error: 'Missing kind' }, { status: 400 });
    }

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    // -------------------------------------------------------------------------
    // Flow 1: check_reissue — Stripe $999.99 (instant) flow.
    //
    // The admin Request Check Reissue button (RequestCheckReissueButton) now
    // presents TWO billing options:
    //   • Pay $999.99 via Stripe Checkout (this endpoint) — work starts on
    //     payment confirmation, fastest path. Subtle $0.01 discount roughly
    //     offsets the ~2.9% Stripe processing fee so net revenue is similar
    //     to the $1,000 Mercury ACH path.
    //   • Request $1,000 Mercury ACH invoice (POST /api/admin/check-reissue
    //     without kicking off this purchase) — net-15 friendly, manual
    //     invoice from Matt, work starts on Mercury payment confirmation.
    //
    // Both paths first create a row in check_reissue_requests via
    // /api/admin/check-reissue. The Stripe path THEN calls this endpoint to
    // generate the checkout session and stamp stripe_session_id on the row.
    // The Mercury path stops at the email notification step.
    // -------------------------------------------------------------------------
    if (body.kind === 'check_reissue') {
      if (!body.check_reissue_id) {
        return NextResponse.json({ error: 'check_reissue_id required' }, { status: 400 });
      }

      const { data: row } = await admin
        .from('check_reissue_requests' as any)
        .select('id, client_id, entity_id, tax_year, tax_quarter, status, payment_status, service_fee, original_refund_amount, clients:client_id(*)')
        .eq('id', body.check_reissue_id)
        .single() as { data: any };
      if (!row) return NextResponse.json({ error: 'Reissue request not found' }, { status: 404 });
      if (row.payment_status === 'paid') {
        return NextResponse.json({ error: 'Already paid', already_paid: true }, { status: 409 });
      }
      if (!isAdmin && row.client_id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized for this client' }, { status: 403 });
      }

      const customerId = await findOrCreateStripeCustomer(row.clients, admin);
      // $999.99 (1 cent under the Mercury $1,000 invoice — psychological
      // anchor that roughly offsets Stripe's 2.9% processing fee).
      const fee = 999.99;

      const checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(fee * 100),
            product_data: {
              name: 'ModernTax — IRS Check Reissue Recovery Service',
              description: `${row.clients?.name || 'Client'} — Recover undelivered IRS refund check for ${row.tax_year} Q${row.tax_quarter}${row.original_refund_amount ? ` ($${Number(row.original_refund_amount).toFixed(2)} originally issued)` : ''}. We file Form 8822-B + call the IRS Business & Specialty Tax line on the client's behalf.`,
            },
          },
          quantity: 1,
        }],
        success_url: `${baseUrl}/admin/erc-report/${row.entity_id}?reissue=paid&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${baseUrl}/admin/erc-report/${row.entity_id}?reissue=cancel`,
        metadata: {
          flow: 'check_reissue',
          check_reissue_id: row.id,
          entity_id: row.entity_id,
          moderntax_client_id: row.client_id,
          moderntax_user_id: user.id,
        },
        custom_text: {
          submit: {
            message: 'Service starts the moment payment confirms. Expected timeline: Form 8822-B filed within 1 business day, IRS Business & Specialty Tax line called within 3 business days, check reissue typically posted by IRS within 4-8 weeks of address update.',
          },
        },
      });

      if (!checkout.url) {
        return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
      }

      await (admin.from('check_reissue_requests' as any) as any)
        .update({
          payment_status: 'checkout_pending',
          stripe_session_id: checkout.id,
        })
        .eq('id', row.id);

      return NextResponse.json({ url: checkout.url, sessionId: checkout.id });
    }

    // -------------------------------------------------------------------------
    // Flow 2: erc_full_sweep — $79.98 premium upgrade per 941 entity
    // -------------------------------------------------------------------------
    if (body.kind === 'erc_full_sweep') {
      if (!body.entity_id) {
        return NextResponse.json({ error: 'entity_id required' }, { status: 400 });
      }

      const { data: ent } = await admin
        .from('request_entities')
        .select('id, entity_name, form_type, erc_full_sweep_paid, request_id, requests(client_id, clients(*))')
        .eq('id', body.entity_id)
        .single() as { data: any };
      if (!ent) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
      if (ent.form_type !== '941') {
        return NextResponse.json({ error: 'ERC full-sweep is only available for 941 entities' }, { status: 400 });
      }
      if (ent.erc_full_sweep_paid) {
        return NextResponse.json({ error: 'Full sweep already paid', already_paid: true }, { status: 409 });
      }

      const client = ent.requests?.clients;
      if (!client) return NextResponse.json({ error: 'Entity has no client linkage' }, { status: 500 });
      // Non-admins can only pay for their own client's entities.
      if (!isAdmin && client.id !== profile.client_id) {
        return NextResponse.json({ error: 'Not authorized for this client' }, { status: 403 });
      }

      const customerId = await findOrCreateStripeCustomer(client, admin);

      const checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(PRICE_ERC_FULL_SWEEP_PREMIUM * 100),
            product_data: {
              name: 'ModernTax — ERC Full-Sweep Premium',
              description: `${ent.entity_name} — upgrade from base ERC analysis (up to 3 quarters) to full sweep (all 6–7 eligible ERC quarters: 2020 Q2–Q4 + 2021 Q1–Q3, plus Q4 2021 for Recovery Startup Businesses).`,
            },
          },
          quantity: 1,
        }],
        success_url: `${baseUrl}/admin/erc-report/${ent.id}?upgrade=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${baseUrl}/admin/erc-report/${ent.id}?upgrade=cancel`,
        metadata: {
          flow: 'erc_full_sweep',
          entity_id: ent.id,
          moderntax_client_id: client.id,
          moderntax_user_id: user.id,
        },
        custom_text: {
          submit: {
            message: 'After payment, the expert pulls all eligible ERC quarters and re-runs the ERC analysis report. Typical turnaround: same business day if IRS PPS is available.',
          },
        },
      });

      if (!checkout.url) {
        return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
      }

      await (admin.from('request_entities') as any)
        .update({ erc_full_sweep_session_id: checkout.id })
        .eq('id', ent.id);

      return NextResponse.json({ url: checkout.url, sessionId: checkout.id });
    }

    return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
  } catch (err) {
    console.error('[billing/purchase] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
