/**
 * Per-order billing (#3, 2026-06-28).
 *
 * For clients on billing_mode='card_per_order', each completed order is billed
 * same-day to their saved card (off_session PaymentIntent) instead of rolling
 * into a monthly net-30 Mercury invoice. A per-order `invoices` row is the
 * record of truth (so dunning + the invoice UI work uniformly).
 *
 * Outcomes:
 *   - card on file → off_session charge → invoice 'paid' (or 'payment_failed').
 *   - no card on file → a Stripe Checkout payment link → invoice 'sent'.
 * Idempotent: one invoice per entity (DB partial-unique on entity_id).
 *
 * Money path mirrors app/api/cron/send-may-2026-monitoring-stripe (the proven
 * off_session pattern). Never stores card data; Stripe holds the method.
 */

import { getStripe, findOrCreateStripeCustomer } from './stripe';
import { entityBillableRate, PRICE_STANDARD } from './pricing';

export interface OrderBillClient {
  id: string;
  name: string;
  slug?: string | null;
  billing_rate_pdf?: number | null;
  billing_ap_email?: string | null;
  stripe_customer_id?: string | null;
  stripe_payment_method_id?: string | null;
  payment_method_status?: string | null;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
}

export interface OrderBillEntity {
  id: string;
  entity_name: string;
  gross_receipts?: any;
  credit_paid?: boolean | null;
}

export type OrderBillStatus =
  | 'charged'            // card charged successfully → invoice paid
  | 'payment_link_sent' // no card → Checkout link created → invoice sent
  | 'payment_failed'    // card declined → invoice payment_failed (dunning takes over)
  | 'skipped'           // already billed / credit-paid / zero price
  | 'error';

export interface OrderBillResult {
  entity_id: string;
  entity_name: string;
  status: OrderBillStatus;
  invoice_id?: string;
  amount?: number;
  payment_link?: string | null;
  detail?: string;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

/**
 * Bill one completed entity for a card_per_order client. Pure side-effects via
 * the passed service-role `admin` client. Safe to call repeatedly (idempotent).
 *
 * @param dryRun  when true, computes the price + plan but writes/charges nothing
 *                (shadow mode — what it WOULD do).
 */
export async function billCompletedEntity(
  admin: any,
  entity: OrderBillEntity,
  client: OrderBillClient,
  dryRun = false,
): Promise<OrderBillResult> {
  const base = { entity_id: entity.id, entity_name: entity.entity_name };

  if (entity.credit_paid) return { ...base, status: 'skipped', detail: 'credit_paid' };

  // Idempotency — one invoice per entity (also enforced by partial-unique index).
  const { data: existing } = await admin.from('invoices')
    .select('id, status, stripe_payment_link_url').eq('entity_id', entity.id).maybeSingle() as { data: any };
  if (existing) {
    return { ...base, status: 'skipped', invoice_id: existing.id, detail: `exists:${existing.status}` };
  }

  const clientRate = Number(client.billing_rate_pdf) || PRICE_STANDARD;
  const { price, kind } = entityBillableRate(entity.gross_receipts, clientRate);
  if (!(price > 0)) return { ...base, status: 'skipped', detail: 'zero_price' };

  if (dryRun) {
    const hasCard = !!client.stripe_payment_method_id && client.payment_method_status === 'active';
    return { ...base, status: hasCard ? 'charged' : 'payment_link_sent', amount: price,
      detail: `DRY-RUN would ${hasCard ? `charge ${client.payment_method_brand} ••${client.payment_method_last4}` : 'send a payment link'} for $${price.toFixed(2)} (${kind})` };
  }

  const today = new Date().toISOString().slice(0, 10);
  // Insert the per-order invoice first (record of truth before any money moves).
  const { data: inv, error: invErr } = await admin.from('invoices').insert({
    client_id: client.id,
    entity_id: entity.id,
    invoice_kind: 'per_order',
    invoice_number: `INV-ORD-${entity.id.slice(0, 8).toUpperCase()}`,
    billing_period_start: today,
    billing_period_end: today,
    total_entities: 1,
    total_amount: price,
    status: 'draft',
    due_date: today,
    notes: `Per-order charge — ${entity.entity_name} (${kind}).`,
  }).select('id').single() as { data: any; error: any };
  if (invErr) return { ...base, status: 'error', detail: `invoice insert: ${invErr.message}` };

  const hasCard = !!client.stripe_payment_method_id && client.payment_method_status === 'active';
  const stripe = getStripe();

  if (hasCard) {
    try {
      const customerId = await findOrCreateStripeCustomer(client, admin);
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(price * 100),
        currency: 'usd',
        customer: customerId,
        payment_method: client.stripe_payment_method_id!,
        off_session: true,
        confirm: true,
        description: `ModernTax order — ${entity.entity_name}`,
        metadata: { moderntax_client_id: client.id, entity_id: entity.id, kind },
      });
      const ok = pi.status === 'succeeded';
      await admin.from('invoices').update({
        stripe_payment_intent_id: pi.id,
        stripe_charge_id: typeof pi.latest_charge === 'string' ? pi.latest_charge : null,
        payment_method: 'stripe',
        paid_via: ok ? 'stripe' : null,
        status: ok ? 'paid' : 'payment_failed',
        paid_at: ok ? new Date().toISOString() : null,
        sent_at: new Date().toISOString(),
      }).eq('id', inv.id);
      return { ...base, status: ok ? 'charged' : 'payment_failed', invoice_id: inv.id, amount: price, detail: pi.status };
    } catch (e: any) {
      // Declined / authentication_required / API error → mark failed, attach a
      // payment link so dunning can chase a manual payment.
      let link: string | null = null;
      try { link = await createOrderPaymentLink(stripe, admin, client, entity, price, inv.id); } catch { /* best-effort */ }
      await admin.from('invoices').update({
        status: 'payment_failed', payment_method: 'stripe',
        stripe_payment_link_url: link, sent_at: new Date().toISOString(),
        notes: `Card charge failed (${e?.code || e?.message || 'declined'}). Payment link attached for manual pay.`,
      }).eq('id', inv.id);
      return { ...base, status: 'payment_failed', invoice_id: inv.id, amount: price, payment_link: link, detail: e?.code || e?.message };
    }
  }

  // No card on file → Stripe Checkout payment link, invoice 'sent'.
  try {
    const link = await createOrderPaymentLink(stripe, admin, client, entity, price, inv.id);
    await admin.from('invoices').update({
      status: 'sent', payment_method: 'card', stripe_payment_link_url: link, sent_at: new Date().toISOString(),
    }).eq('id', inv.id);
    return { ...base, status: 'payment_link_sent', invoice_id: inv.id, amount: price, payment_link: link };
  } catch (e: any) {
    return { ...base, status: 'error', invoice_id: inv.id, detail: `payment link: ${e?.message}` };
  }
}

/** A hosted Stripe Checkout link to pay a single per-order invoice by card. */
async function createOrderPaymentLink(
  stripe: ReturnType<typeof getStripe>,
  admin: any,
  client: OrderBillClient,
  entity: OrderBillEntity,
  price: number,
  invoiceId: string,
): Promise<string> {
  const customerId = await findOrCreateStripeCustomer(client, admin);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    // Save the card while they pay, so the next order can auto-charge.
    payment_intent_data: { setup_future_usage: 'off_session', metadata: { moderntax_client_id: client.id, entity_id: entity.id, invoice_id: invoiceId } },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(price * 100),
        product_data: { name: `ModernTax transcript order — ${entity.entity_name}` },
      },
    }],
    success_url: `${APP_URL}/billing?paid=1`,
    cancel_url: `${APP_URL}/billing?canceled=1`,
    metadata: { moderntax_client_id: client.id, entity_id: entity.id, invoice_id: invoiceId },
  });
  return session.url || '';
}
