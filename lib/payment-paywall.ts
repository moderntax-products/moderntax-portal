/**
 * Mercury payment-method paywall — gate request creation on whether a
 * client has a Mercury account on file (or is on the explicit bypass list).
 *
 * Driver: TaxTaker (and any new client onboarded after 2026-05-14) must
 * have `clients.mercury_customer_id` set before submitting a new request.
 * We're routing all new billing through Mercury ACH while the Stripe
 * processing balance gets paid down.
 *
 * The three pre-existing trusted clients have `bypass_payment_paywall = TRUE`
 * set via supabase/migration-mercury-paywall.sql:
 *   · Centerstone SBA Lending
 *   · California Statewide CDC
 *   · Clearfirm
 *
 * Usage at every request-creation entrypoint:
 *
 *   const block = await checkPaymentPaywall(supabase, clientId);
 *   if (block) return block;   // returns NextResponse 402 with paywall message
 *
 * Or for non-NextResponse callers:
 *
 *   const status = await getPaywallStatus(supabase, clientId);
 *   if (status.blocked) { ... }
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PaywallStatus {
  /** True if the client is blocked from submitting new requests. */
  blocked: boolean;
  /** Human-readable reason. Null when not blocked. */
  reason: string | null;
  /** The client's name for use in error messages. */
  clientName: string | null;
}

/**
 * Inspect the client and return whether they're blocked + why.
 * Pure data — does not produce a Response.
 */
export async function getPaywallStatus(
  supabase: SupabaseClient,
  clientId: string,
): Promise<PaywallStatus> {
  if (!clientId) {
    return { blocked: true, reason: 'No client ID provided.', clientName: null };
  }

  const { data: client, error } = await supabase
    .from('clients')
    .select('name, slug, mercury_customer_id, bypass_payment_paywall')
    .eq('id', clientId)
    .maybeSingle() as { data: { name: string; slug: string; mercury_customer_id: string | null; bypass_payment_paywall: boolean | null } | null; error: any };

  // Two-phase fallback: if `bypass_payment_paywall` column doesn't exist
  // yet (migration not applied), assume false and rely solely on
  // mercury_customer_id presence. This keeps the paywall safe-by-default
  // even before the migration runs in a given environment.
  if (error && /bypass_payment_paywall|column .* does not exist|42703/i.test(error.message || '')) {
    const r2 = await supabase
      .from('clients')
      .select('name, slug, mercury_customer_id')
      .eq('id', clientId)
      .maybeSingle() as { data: { name: string; slug: string; mercury_customer_id: string | null } | null; error: any };
    if (r2.error || !r2.data) {
      return { blocked: true, reason: `Client lookup failed: ${r2.error?.message || 'not found'}`, clientName: null };
    }
    // Sandbox auto-exemption (mirror of the main path below).
    if (r2.data.slug && /-sandbox$/i.test(r2.data.slug)) {
      return { blocked: false, reason: null, clientName: r2.data.name };
    }
    if (r2.data.mercury_customer_id) {
      return { blocked: false, reason: null, clientName: r2.data.name };
    }
    return {
      blocked: true,
      reason: 'No Mercury payment method on file. Contact billing@moderntax.io to connect your Mercury account before submitting new requests.',
      clientName: r2.data.name,
    };
  }

  if (!client) {
    return { blocked: true, reason: `Client lookup failed: ${error?.message || 'not found'}`, clientName: null };
  }

  // Sandbox clients (slug ending in -sandbox) are auto-exempt — synthetic
  // test accounts (Vine, Collective, Moxie) have no Mercury setup by
  // design, and prospects need to be able to curl them without us asking
  // for billing details.
  if (client.slug && /-sandbox$/i.test(client.slug)) {
    return { blocked: false, reason: null, clientName: client.name };
  }
  if (client.bypass_payment_paywall) {
    return { blocked: false, reason: null, clientName: client.name };
  }
  if (client.mercury_customer_id) {
    return { blocked: false, reason: null, clientName: client.name };
  }
  return {
    blocked: true,
    reason: 'No Mercury payment method on file. Contact billing@moderntax.io to connect your Mercury account before submitting new requests.',
    clientName: client.name,
  };
}

/**
 * Convenience: returns a 402 NextResponse with the paywall message when
 * blocked, or null when allowed. Use at the top of a route handler:
 *
 *   const block = await checkPaymentPaywall(supabase, clientId);
 *   if (block) return block;
 */
export async function checkPaymentPaywall(
  supabase: SupabaseClient,
  clientId: string,
): Promise<NextResponse | null> {
  const status = await getPaywallStatus(supabase, clientId);
  if (!status.blocked) return null;
  return NextResponse.json(
    {
      error: 'payment_method_required',
      message: status.reason,
      client_name: status.clientName,
      next_steps: [
        'Email billing@moderntax.io with your Mercury account email so we can link your account for invoicing.',
        'Once linked, your future requests will auto-bill via Mercury ACH (no per-request friction).',
        'Existing in-flight requests are unaffected by this change.',
      ],
      docs_url: 'https://portal.moderntax.io/billing/connect-mercury',
    },
    { status: 402 },  // 402 Payment Required — semantically correct for this case
  );
}
