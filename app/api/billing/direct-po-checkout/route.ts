/**
 * POST /api/billing/direct-po-checkout
 *
 * Taxpayer-facing. Takes a Direct public `token`, loads the entity's stored
 * Purchase Order, and creates ONE Stripe Checkout session that bills every
 * up-front (non-contingency) line item as its own line — the first true
 * multi-line, PO-backed charge in the app. Contingency lines (ERC recovery)
 * are intentionally excluded: those bill only on success.
 *
 * Account credit is applied as a one-time Stripe coupon so it shows on the
 * receipt as a discount rather than silently netting the total.
 *
 * On session creation the PO flips draft → approved (the taxpayer committed by
 * hitting pay); the webhook flips it approved → paid.
 *
 * Body: { token: string }
 * Auth: none (token is the capability) — mirrors self-serve-checkout.
 *
 * Matt 2026-07-27.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { getStripe } from '@/lib/stripe';
import { fmtUsd } from '@/lib/pricing';
import type { DirectPurchaseOrder } from '@/lib/direct-purchase-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { token?: string } | null;
    const tok = body?.token?.trim();
    if (!tok) return NextResponse.json({ error: 'token required' }, { status: 400 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts, requests!inner(id, client_id)')
      .eq('gross_receipts->>direct_token', tok).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const gr = entity.gross_receipts || {};
    const po = gr.purchase_order as DirectPurchaseOrder | undefined;
    if (!po) return NextResponse.json({ error: 'No purchase order on this entity yet.' }, { status: 409 });
    if (po.status === 'paid') {
      return NextResponse.json({ error: 'This order is already paid.' }, { status: 409 });
    }

    const billable = (po.lineItems || []).filter((l) => !l.billLater && l.amount > 0);
    if (!billable.length) {
      return NextResponse.json({ error: 'Nothing to charge up front on this order.' }, { status: 409 });
    }

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

    const line_items = billable.map((l) => ({
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(l.unitPrice * 100),
        product_data: {
          name: l.label,
          description: l.qty > 1 ? `${l.qty} × ${l.unit} — ${fmtUsd(l.unitPrice)} each` : l.description.slice(0, 240),
        },
      },
      quantity: l.qty,
    }));

    // Account credit → one-time coupon so it prints as a discount line.
    let discounts: { coupon: string }[] | undefined;
    const credit = Math.min(Number(po.creditApplied) || 0, po.subtotal);
    if (credit > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: Math.round(credit * 100),
        currency: 'usd',
        duration: 'once',
        name: 'ModernTax account credit',
      });
      discounts = [{ coupon: coupon.id }];
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_creation: 'always',
      billing_address_collection: 'auto',
      line_items,
      discounts,
      success_url: `${baseUrl}/direct/${tok}?paid=1`,
      cancel_url: `${baseUrl}/direct/${tok}?cancel=1`,
      metadata: {
        flow: 'direct_po',
        entity_id: entity.id,
        request_id: entity.requests?.id || '',
        po_number: po.poNumber,
        credit_applied: String(credit),
        chargeable_total: String(po.chargeableTotal),
      },
    });

    if (!checkout.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });

    // Mark the PO approved (taxpayer committed to pay).
    const newGr = {
      ...gr,
      purchase_order: { ...po, status: 'approved', approvedAt: new Date().toISOString() },
    };
    await (admin.from('request_entities') as any).update({ gross_receipts: newGr }).eq('id', entity.id);

    return NextResponse.json({ url: checkout.url, amount: po.chargeableTotal });
  } catch (err: any) {
    console.error('[direct-po-checkout]', err);
    return NextResponse.json({ error: err?.message || 'Checkout failed' }, { status: 500 });
  }
}
