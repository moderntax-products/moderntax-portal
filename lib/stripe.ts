/**
 * Stripe helpers — single import point for the Stripe SDK + the conventions
 * we use across endpoints.
 *
 * Initialization rules:
 *   - Server-only. Never imported into a Client Component or 'use client' file.
 *   - Uses STRIPE_SECRET_KEY from env. Throws on first call if missing so the
 *     misconfiguration is loud (vs silent failures in payment paths).
 *   - API version is pinned so behavior is stable across SDK upgrades.
 *
 * Pricing model (matches the codebase's per-pull / per-month conventions):
 *   - Customer per ModernTax client (`stripe_customer_id` on clients table).
 *   - Default payment method saved as `stripe_payment_method_id`.
 *   - Auto-charges happen via off_session PaymentIntents — the customer
 *     authorized future charges when they attached the method, so we don't
 *     need 3DS re-auth for each invoice.
 */

import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY env var not set — payment flows disabled');
  }
  _stripe = new Stripe(key, {
    apiVersion: '2026-04-22.dahlia', // pin to current SDK default
    typescript: true,
    appInfo: { name: 'ModernTax Portal', url: 'https://portal.moderntax.io' },
  });
  return _stripe;
}

/**
 * Find-or-create a Stripe Customer for a ModernTax client. Idempotent on
 * `clients.stripe_customer_id` — once set, we never re-create.
 *
 * @param client      Row from public.clients (must include id, name, billing_ap_email)
 * @param adminSupabase  Service-role Supabase client to persist the new customer ID
 */
export async function findOrCreateStripeCustomer(
  client: {
    id: string;
    name: string;
    stripe_customer_id?: string | null;
    billing_ap_email?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    // Address columns in our schema all carry the `address_` prefix — see
    // app/api/cron/auto-invoice for the canonical select. NOT city/state/zip_code.
    address_city?: string | null;
    address_state?: string | null;
    address_postal_code?: string | null;
    address_country?: string | null;
  },
  adminSupabase: any,
): Promise<string> {
  if (client.stripe_customer_id) return client.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: client.name,
    email: client.billing_ap_email || undefined,
    metadata: { moderntax_client_id: client.id },
    address: client.address_line1 ? {
      line1: client.address_line1,
      line2: client.address_line2 || undefined,
      city: client.address_city || undefined,
      state: client.address_state || undefined,
      postal_code: client.address_postal_code || undefined,
      country: client.address_country || 'US',
    } : undefined,
  });

  // Cast to any — Supabase generated types don't yet know about
  // stripe_customer_id (added in supabase/migration-stripe-payment-method.sql)
  // until the types are regenerated.
  await (adminSupabase
    .from('clients') as any)
    .update({ stripe_customer_id: customer.id })
    .eq('id', client.id);

  return customer.id;
}

/**
 * Render the saved payment method's user-facing label.
 *
 * Card: "Visa ending in 4242"
 * ACH:  "Chase Bank ending in 6789"
 * Empty (no method): "No payment method on file"
 */
export function formatPaymentMethodLabel(client: {
  payment_method_type?: string | null;
  payment_method_brand?: string | null;
  payment_method_last4?: string | null;
}): string {
  if (!client.payment_method_last4) return 'No payment method on file';
  const brand = client.payment_method_brand || '';
  const niceBrand = brand
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (client.payment_method_type === 'us_bank_account') {
    return `${niceBrand || 'Bank account'} ending in ${client.payment_method_last4}`;
  }
  return `${niceBrand || 'Card'} ending in ${client.payment_method_last4}`;
}
