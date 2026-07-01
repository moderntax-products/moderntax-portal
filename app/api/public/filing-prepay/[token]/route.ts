/**
 * POST /api/public/filing-prepay/[token]
 *
 * Token-gated, NO-LOGIN Stripe Checkout so a ModernTax Direct taxpayer can
 * PREPAY for their back-year return filing before an account exists — the same
 * link we email them for the review page (/review/[token]). Unlike
 * /api/billing/filing-fee-checkout (which is post-completion + cookie-auth),
 * this collects payment UP FRONT so the expert can start, and offers a rush
 * upgrade.
 *
 * Body: { expedited?: boolean }
 *
 * Pricing (see lib/pricing.ts):
 *   base   = PRICE_BACKYEAR_FILING ($50) × number of open years on the entity
 *   rush   = + PRICE_FILING_EXPEDITE_FEE when expedited
 *   credit = less the client's account credit_balance (e.g. the $100 deposit)
 * The $50/yr is a STARTING quote — the expert quotes the full price once they
 * have context; this prepay is the deposit/commitment, not the final bill.
 *
 * On success Stripe fires checkout.session.completed with flow=backyear_filing
 * (metadata prepay=1, expedited flag), handled in the stripe webhook: records
 * the payment on the entity and, when expedited, sets filing.rush=true for
 * priority assignment.
 *
 * Auth: the signed token alone (verifyFilingIntakeToken) — same trust model as
 * the intake + resolve pages. No PII is returned; only a Stripe URL.
 *
 * Matt 2026-06-30.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';
import { getStripe } from '@/lib/stripe';
import { PRICE_BACKYEAR_FILING, PRICE_FILING_EXPEDITE_FEE } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const entityId = verifyFilingIntakeToken(params.token);
    if (!entityId) return NextResponse.json({ error: 'This link isn’t valid.' }, { status: 401 });

    const body = (await request.json().catch(() => null)) as { expedited?: boolean } | null;
    const expedited = body?.expedited === true;

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts, requests!inner(id, client_id, clients(name))')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });

    // Open years to file — explicit, from the review/filing scope. Never inferred.
    const filing = entity.gross_receipts?.filing || {};
    const openYears: string[] = Array.isArray(filing.to_file_years) && filing.to_file_years.length
      ? filing.to_file_years.map(String)
      : [];
    const yearCount = openYears.length || Number(filing.years_filed) || 0;
    if (!yearCount) {
      return NextResponse.json({ error: 'No open filing years are recorded for this entity yet.' }, { status: 409 });
    }

    const base = PRICE_BACKYEAR_FILING * yearCount;
    const rush = expedited ? PRICE_FILING_EXPEDITE_FEE : 0;
    const gross = base + rush;

    // Apply the client's account credit (e.g. the ModernTax Direct deposit).
    const { data: client } = await admin.from('clients')
      .select('credit_balance').eq('id', entity.requests?.client_id).single() as { data: { credit_balance: number | null } | null };
    const credit = Math.max(0, Number(client?.credit_balance) || 0);
    const creditApplied = Math.min(credit, gross);
    const net = Math.round((gross - creditApplied) * 100); // cents
    if (net <= 0) {
      return NextResponse.json({
        error: 'This deposit is fully covered by your account credit — no payment needed. Your expert will reach out.',
      }, { status: 409 });
    }

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
    const yrLabel = `${yearCount} prior-year federal return${yearCount === 1 ? '' : 's'}`;
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
            name: `${expedited ? 'Expedited ' : ''}back-year filing — ${entity.entity_name}`,
            description: `${yrLabel} × $${PRICE_BACKYEAR_FILING.toFixed(2)}`
              + (expedited ? ` + $${PRICE_FILING_EXPEDITE_FEE.toFixed(2)} rush` : '')
              + (creditApplied > 0 ? ` (less $${creditApplied.toFixed(2)} account credit)` : '')
              + '. Starting deposit — your expert confirms the full quote after review.',
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/review/${params.token}?paid=1`,
      cancel_url: `${baseUrl}/review/${params.token}?cancel=1`,
      metadata: {
        flow: 'backyear_filing',
        prepay: '1',
        expedited: expedited ? 'true' : 'false',
        entity_id: entity.id,
        request_id: entity.requests?.id || '',
        client: entity.requests?.clients?.name || '',
        years_filed: String(yearCount),
        fee_per_year: String(PRICE_BACKYEAR_FILING),
        rush_fee: String(rush),
        credit_applied: String(creditApplied),
      },
    });

    return NextResponse.json({ url: checkout.url });
  } catch (err: any) {
    console.error('[filing-prepay] error', err?.message || err);
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 });
  }
}
