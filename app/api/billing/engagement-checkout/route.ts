/**
 * POST /api/billing/engagement-checkout
 *
 * Team endpoint (admin). Creates a Stripe Checkout session for a bespoke,
 * billable-hour resolution engagement quoted off the Compliance Audit board.
 * There is NO fixed SKU — each case is priced on its own: the caller passes
 * either { hours, rate } or a flat { amount }, plus a description. We build a
 * single custom line item and return a payment URL the team sends to the
 * client/taxpayer.
 *
 * Also stamps a `quoted` engagement onto the entity's
 * gross_receipts.engagements[] so the board reflects that a quote is out; the
 * webhook (flow=resolution_engagement) flips it to `paid`.
 *
 * Body: { entityId, description, hours?, rate?, amount?, notes? }
 * Auth: admin only.
 *
 * Matt 2026-07-28.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { getStripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      entityId?: string;
      description?: string;
      hours?: number;
      rate?: number;
      amount?: number;
      notes?: string;
    } | null;

    const entityId = body?.entityId?.trim();
    const description = body?.description?.trim();
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });
    if (!description) return NextResponse.json({ error: 'A description of the engagement is required' }, { status: 400 });

    // Resolve the amount: hours × rate, or a flat amount.
    const hours = Number(body?.hours);
    const rate = Number(body?.rate);
    let amount = Number(body?.amount);
    if (Number.isFinite(hours) && hours > 0 && Number.isFinite(rate) && rate > 0) {
      amount = Math.round(hours * rate * 100) / 100;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Provide hours × rate, or a flat amount greater than 0' }, { status: 400 });
    }
    if (amount > 1_000_000) {
      return NextResponse.json({ error: 'Amount exceeds the $1,000,000 single-charge limit' }, { status: 400 });
    }

    // Admin only.
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as {
      data: { role: string | null } | null;
    };
    if (!profile || profile.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const admin = createAdminClient();
    const { data: entity } = await admin.from('request_entities')
      .select('id, entity_name, gross_receipts, requests!inner(id, client_id, clients(name))')
      .eq('id', entityId).single() as { data: any };
    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const stripe = getStripe();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
    const isHourly = Number.isFinite(hours) && hours > 0 && Number.isFinite(rate) && rate > 0;

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_creation: 'always',
      billing_address_collection: 'auto',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: `Tax resolution engagement — ${entity.entity_name}`,
            description: isHourly ? `${description} (${hours} hrs × $${rate}/hr)` : description,
          },
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/admin/compliance-audit?paid=${entity.id}`,
      cancel_url: `${baseUrl}/admin/compliance-audit?cancel=${entity.id}`,
      metadata: {
        flow: 'resolution_engagement',
        entity_id: entity.id,
        request_id: entity.requests?.id || '',
        client: entity.requests?.clients?.name || '',
        description,
        hours: isHourly ? String(hours) : '',
        rate: isHourly ? String(rate) : '',
        amount: String(amount),
      },
    });

    if (!checkout.url) return NextResponse.json({ error: 'Stripe did not return a URL' }, { status: 500 });

    // Stamp a "quoted" engagement so the board shows the quote is out.
    const gr = entity.gross_receipts || {};
    const engagements = Array.isArray(gr.engagements) ? gr.engagements : [];
    engagements.push({
      status: 'quoted',
      description,
      hours: isHourly ? hours : null,
      rate: isHourly ? rate : null,
      amount,
      notes: body?.notes || null,
      quoted_by: user.id,
      quoted_at: new Date().toISOString(),
      checkout_session: checkout.id,
      pay_url: checkout.url,
    });
    await (admin.from('request_entities') as any).update({ gross_receipts: { ...gr, engagements } }).eq('id', entity.id);

    return NextResponse.json({ url: checkout.url, sessionId: checkout.id, amount });
  } catch (err: any) {
    console.error('[engagement-checkout]', err);
    return NextResponse.json({ error: err?.message || 'Checkout failed' }, { status: 500 });
  }
}
