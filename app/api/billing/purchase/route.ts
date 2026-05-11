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
 *   1. kind=check_reissue
 *      Body: { kind: 'check_reissue', check_reissue_id: <uuid> }
 *      Looks up the check_reissue_requests row, charges
 *      PRICE_CHECK_REISSUE ($1,000), stores stripe_session_id on the
 *      row. Webhook flips payment_status to 'paid' on success and
 *      the admin queue can then start the work.
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
import {
  PRICE_CHECK_REISSUE,
  PRICE_ERC_FULL_SWEEP_PREMIUM,
} from '@/lib/pricing';

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
    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin only' }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as PurchaseBody | null;
    if (!body || !body.kind) {
      return NextResponse.json({ error: 'Missing kind' }, { status: 400 });
    }

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    // -------------------------------------------------------------------------
    // Flow 1: check_reissue — $1,000 per check
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

      const customerId = await findOrCreateStripeCustomer(row.clients, admin);
      const fee = Number(row.service_fee) || PRICE_CHECK_REISSUE;

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
            message: 'Service begins immediately upon payment confirmation. Estimated 4–8 weeks to recover the check from the IRS, plus typical mail-delivery time. Refunded if we can\'t complete the recovery.',
          },
        },
      });

      if (!checkout.url) {
        return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
      }

      // Persist the session id on the row so the webhook can match it
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
