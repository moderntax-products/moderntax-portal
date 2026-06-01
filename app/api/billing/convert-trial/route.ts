/**
 * POST /api/billing/convert-trial
 * Auto-converts a trial client to paid via Stripe off-session charge.
 * Called by trial-expiry cron, admin UI, and entity-completion webhook.
 * Auth: CRON_SECRET or admin session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { requireBearer } from '@/lib/auth-util';
import { convertTrial } from '@/lib/trial-activate';
import { logFunnelEvent } from '@/lib/funnel-events';
import Stripe from 'stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONVERSION_AMOUNT_CENTS = 5998; // $59.98

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') || '';
  const isCron = authHeader.startsWith('Bearer ');

  if (isCron) {
    const unauthorized = requireBearer(request, process.env.CRON_SECRET);
    if (unauthorized) return unauthorized;
  } else {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: any };
    if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  let body: { client_id?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const clientId = body.client_id?.trim();
  if (!clientId) return NextResponse.json({ error: 'client_id required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: client } = await (admin.from('clients') as any)
    .select('id, name, stripe_customer_id, stripe_payment_method_id, payment_method_status, trial_converted_at')
    .eq('id', clientId).single() as { data: any };

  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  if (client.trial_converted_at) return NextResponse.json({ already_converted: true, trial_converted_at: client.trial_converted_at });

  if (!client.stripe_payment_method_id || client.payment_method_status !== 'active') {
    await logFunnelEvent(admin, 'conversion_failed', clientId, null, { reason: 'no_payment_method' });
    return NextResponse.json({ error: 'No active payment method on file' }, { status: 402 });
  }

  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' as any });

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: CONVERSION_AMOUNT_CENTS,
      currency: 'usd',
      customer: client.stripe_customer_id,
      payment_method: client.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: { flow: 'trial_auto_convert', moderntax_client_id: clientId, client_name: client.name },
      description: `ModernTax trial auto-conversion — ${client.name}`,
    });
  } catch (err: any) {
    await logFunnelEvent(admin, 'conversion_failed', clientId, null, { reason: err?.code || 'stripe_error', stripe_error: err?.message });
    return NextResponse.json({ error: 'Payment failed: ' + (err?.message || 'unknown'), code: err?.code }, { status: 402 });
  }

  if (paymentIntent.status !== 'succeeded') {
    await logFunnelEvent(admin, 'conversion_failed', clientId, null, { reason: 'pi_not_succeeded', status: paymentIntent.status });
    return NextResponse.json({ error: 'Payment not succeeded', status: paymentIntent.status }, { status: 402 });
  }

  await convertTrial(admin, clientId, null, paymentIntent.id, CONVERSION_AMOUNT_CENTS);
  await (admin.from('clients') as any).update({ free_trial: false }).eq('id', clientId);

  try {
    await (admin.from('invoices') as any).insert({
      client_id: clientId,
      invoice_number: `CONV-${clientId.slice(0, 8)}-${Date.now()}`,
      billing_period_start: new Date().toISOString().slice(0, 10),
      billing_period_end: new Date().toISOString().slice(0, 10),
      total_entities: 1,
      total_amount: CONVERSION_AMOUNT_CENTS / 100,
      status: 'paid',
      payment_method: 'stripe',
      notes: `Trial auto-conversion — PI ${paymentIntent.id}`,
    });
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true, client_id: clientId, payment_intent_id: paymentIntent.id, amount_charged: CONVERSION_AMOUNT_CENTS / 100 });
}
