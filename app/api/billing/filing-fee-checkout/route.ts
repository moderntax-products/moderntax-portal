/**
 * POST /api/billing/filing-fee-checkout
 *
 * Creates a Stripe Checkout session for a ModernTax Direct client to pay the
 * back-year return filing fee ($50 × number of prior-year returns filed) AFTER
 * the work is complete. Surfaced in the portal by components/FilingFeePayment
 * once the entity's request is completed.
 *
 * Body: { entityId: string }
 *
 * The number of billable years is read from the entity's
 * gross_receipts.filing.years_filed (set by the team at completion) — never
 * inferred, so we don't over/under-bill. Returns { url } for the client to
 * pay; Stripe collects the card + email at checkout.
 *
 * Auth: admin, or a logged-in user on the entity's client. (The team can also
 * generate the URL and send it to the taxpayer.)
 *
 * Matt 2026-06-23.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe } from '@/lib/stripe';
import { PRICE_BACKYEAR_FILING } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { entityId?: string } | null;
    const entityId = body?.entityId?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });

    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role, client_id').eq('id', user.id).single() as {
      data: { role: string | null; client_id: string | null } | null;
    };
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 403 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, status, gross_receipts, requests!inner(id, status, loan_number, client_id, clients(name))')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const isAdmin = profile.role === 'admin';
    if (!isAdmin && entity.requests?.client_id !== profile.client_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Only collect the filing fee once the work is done.
    const reqDone = entity.requests?.status === 'completed' || entity.status === 'completed';
    if (!reqDone) {
      return NextResponse.json({ error: 'Filing fee is collected after the returns are completed.' }, { status: 409 });
    }

    // Billable years — explicit, never inferred.
    const yearsFiled = Number(entity.gross_receipts?.filing?.years_filed);
    if (!Number.isFinite(yearsFiled) || yearsFiled <= 0) {
      return NextResponse.json({ error: 'No billable filing years recorded on this entity yet.' }, { status: 409 });
    }
    const gross = PRICE_BACKYEAR_FILING * yearsFiled;

    // Apply the client's account credit (e.g. the ModernTax Direct deposit) —
    // the 8821 pull + intake are free, so the deposit offsets the filing fee.
    const { data: client } = await admin.from('clients')
      .select('credit_balance').eq('id', entity.requests?.client_id).single() as { data: { credit_balance: number | null } | null };
    const credit = Math.max(0, Number(client?.credit_balance) || 0);
    const creditApplied = Math.min(credit, gross);
    const net = Math.round((gross - creditApplied) * 100); // cents
    if (net <= 0) {
      return NextResponse.json({ error: 'Fee is fully covered by account credit — no payment needed (mark it paid + draw down credit).', gross, creditApplied }, { status: 409 });
    }

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_creation: 'always',
      billing_address_collection: 'auto',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: net,
          product_data: {
            name: `Prior-year return filing — ${entity.entity_name}`,
            description: `${yearsFiled} back-year federal return${yearsFiled === 1 ? '' : 's'} × $${PRICE_BACKYEAR_FILING.toFixed(2)}`
              + (creditApplied > 0 ? ` (less $${creditApplied.toFixed(2)} account credit)` : ''),
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/request/${entity.requests?.id}?paid=1`,
      cancel_url: `${baseUrl}/request/${entity.requests?.id}?cancel=1`,
      metadata: {
        flow: 'backyear_filing',
        entity_id: entity.id,
        request_id: entity.requests?.id || '',
        client: entity.requests?.clients?.name || '',
        years_filed: String(yearsFiled),
        fee_per_year: String(PRICE_BACKYEAR_FILING),
        credit_applied: String(creditApplied),
      },
    });

    if (!checkout.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });
    return NextResponse.json({ url: checkout.url, sessionId: checkout.id, gross, creditApplied, amount: net / 100, years: yearsFiled });
  } catch (err: any) {
    console.error('[filing-fee-checkout]', err);
    return NextResponse.json({ error: err?.message || 'Checkout failed' }, { status: 500 });
  }
}
